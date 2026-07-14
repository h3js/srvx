import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execa, type Options as ExecaOptions } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";

const runnerPath = fileURLToPath(new URL("./_cli-run.ts", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/cli", import.meta.url));
const entryFile = resolve(fixtureDir, "server.ts");

function runCli(
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
) {
  return execa(process.execPath, [runnerPath, ...args], {
    cwd: opts.cwd,
    input: opts.input,
    reject: false, // don't throw on non-zero exit; assert on exitCode instead
    env: { NO_COLOR: "1", ...opts.env },
  } as ExecaOptions);
}

describe("cli", () => {
  describe("info flags", () => {
    it("--version prints srvx and runtime versions", async () => {
      const { stdout, exitCode } = await runCli(["--version"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("srvx");
      expect(stdout).toMatch(/node|bun|deno/);
    });

    it("--help and -h (F41) print usage", async () => {
      for (const flag of ["--help", "-h"]) {
        const { stdout, exitCode } = await runCli([flag]);
        expect(exitCode, `${flag} should exit 0`).toBe(0);
        expect(stdout).toContain("SERVE MODE");
        expect(stdout).toContain("FETCH MODE");
      }
    });

    it("F60: main({ args }) honors an explicit args array (in-process)", async () => {
      const { main } = await import("../src/cli.ts");
      let out = "";
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
        out += chunk;
        return true;
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`__exit__:${code}`);
      }) as never);
      try {
        await expect(main({ args: ["--version"] })).rejects.toThrow("__exit__:0");
        expect(out).toContain("srvx");
      } finally {
        writeSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  describe("fetch mode", () => {
    it("exits 0 for a 2xx response", async () => {
      const { stdout, exitCode } = await runCli(["fetch", "/", "--dir", fixtureDir]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("ok");
    });

    it("exits 22 for a non-2xx response", async () => {
      const { exitCode } = await runCli(["fetch", "/bad", "--dir", fixtureDir]);
      expect(exitCode).toBe(22);
    });

    it("F40: `-p <port> fetch ...` parses as fetch mode (value not treated as subcommand)", async () => {
      const { stdout, exitCode } = await runCli(["-p", "8080", "fetch", "/", "--dir", fixtureDir]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("ok");
    });

    it("F39: `-d @-` reads the request body from stdin", async () => {
      const { stdout, exitCode } = await runCli(
        ["fetch", "/echo", "-d", "@-", "--dir", fixtureDir],
        { input: "hello-from-stdin" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("hello-from-stdin");
    });

    it("F39: `-d @file` reads the request body from a file", async () => {
      const { stdout, exitCode } = await runCli([
        "fetch",
        "/echo",
        "-d",
        `@${resolve(fixtureDir, "data.txt")}`,
        "--dir",
        fixtureDir,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("file-body-content");
    });

    it("F44: loads .env before fetching", async () => {
      // `.env` is written into a temp cwd at runtime (a committed `.env` fixture
      // would be swallowed by .gitignore). The entry is loaded via --entry.
      const dir = await mkdtemp(resolve(tmpdir(), "srvx-cli-env-"));
      try {
        await writeFile(resolve(dir, ".env"), "CLI_TEST_VAR=from-env\n");
        const { stdout, exitCode } = await runCli(["fetch", "/env", "--entry", entryFile], {
          cwd: dir,
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("from-env");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("F44: schemeless host:port is treated as an http URL", async () => {
      const port = await getRandomPort("localhost");
      const server = createServer((_req, res) => res.end("remote-ok"));
      await new Promise<void>((r) => server.listen(port, "localhost", () => r()));
      try {
        const { stdout, exitCode } = await runCli(["fetch", `localhost:${port}/`]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("remote-ok");
      } finally {
        server.close();
      }
    });
  });

  describe("serve mode", () => {
    it("serves a fixture entry and responds to requests", async () => {
      const port = await getRandomPort("localhost");
      const child = runCli(["--prod", "--entry", entryFile, "--port", String(port)]);
      try {
        await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
        const res = await fetch(`http://localhost:${port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      } finally {
        child.kill("SIGTERM");
        await child.catch(() => {});
      }
    });

    it("F27: threads an inline serve() maxRequestBodySize through the loader", async () => {
      const port = await getRandomPort("localhost");
      const entry = resolve(fixtureDir, "..", "cli-max-body", "server.ts");
      const child = runCli(["--prod", "--entry", entry, "--port", String(port)]);
      try {
        await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
        const ok = await fetch(`http://localhost:${port}/`, { method: "POST", body: "1234" });
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("1234");
        const tooBig = await fetch(`http://localhost:${port}/`, {
          method: "POST",
          body: "0123456789",
        });
        expect(tooBig.status).toBe(413);
      } finally {
        child.kill("SIGTERM");
        await child.catch(() => {});
      }
    });

    it("F42: `--tls` without cert/key errors instead of downgrading to http", async () => {
      const port = await getRandomPort("localhost");
      const { stderr, exitCode } = await runCli([
        "--prod",
        "--tls",
        "--entry",
        entryFile,
        "--port",
        String(port),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/--cert|--key|tls/i);
    });

    it("F43: an explicit missing `--static` directory errors", async () => {
      const port = await getRandomPort("localhost");
      const { stderr, exitCode } = await runCli([
        "--prod",
        "--entry",
        entryFile,
        "--static",
        "./definitely-missing-dir",
        "--port",
        String(port),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/static/i);
    });
  });

  describe("errors", () => {
    it("F44: an unknown flag prints a one-line message + usage hint (no stack trace)", async () => {
      const { stderr, exitCode } = await runCli(["--nope"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--help");
      expect(stderr).not.toMatch(/\n\s+at\s/); // no stack-trace frames
    });
  });
});
