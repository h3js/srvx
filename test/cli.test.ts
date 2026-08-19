import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execa, type Options as ExecaOptions } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";
import { fetch as undiciFetch, Agent } from "undici";
import { getTLSCert } from "./_utils.ts";

const runnerPath = fileURLToPath(new URL("./_cli-run.ts", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/cli", import.meta.url));
const entryFile = resolve(fixtureDir, "server.ts");
const tlsEntryFile = resolve(fixtureDir, "tls-server.ts");

const tlsCert = await getTLSCert();

// undici dispatcher trusting the fixture CA, optionally presenting a client cert.
function clientAgent(opts: { withClientCert?: boolean } = {}) {
  return new Agent({
    connect: {
      ca: tlsCert.ca,
      ...(opts.withClientCert ? { cert: tlsCert.clientCert, key: tlsCert.clientKey } : {}),
    },
  });
}

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

// Start the CLI on a free port, run `fn`, then always tear the child down.
async function withServedCli(
  args: string[],
  opts: { env?: Record<string, string> },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const port = await getRandomPort("localhost");
  const child = runCli([...args, "--port", String(port)], opts);
  try {
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
    await fn(port);
  } finally {
    child.kill("SIGTERM");
    await child.catch(() => {});
  }
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

    it("NODE_ENV=production (no --prod) suppresses the stack-trace error page", async () => {
      const port = await getRandomPort("localhost");
      const child = runCli(["--entry", entryFile, "--port", String(port)], {
        env: { NODE_ENV: "production" },
      });
      let result: any;
      try {
        await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
        const res = await fetch(`http://localhost:${port}/boom`);
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain("Something went wrong");
        expect(body).not.toContain("BOOM_SECRET");
        expect(body).not.toMatch(/\n\s+at\s/); // no stack-trace frames
      } finally {
        child.kill("SIGTERM");
        result = await child.catch((error: any) => error);
      }
      // NODE_ENV also drives the rest of prod mode (banner, .env.production, no watch)
      expect(result.stdout).toContain("prod");
    });

    it("--prod suppresses the stack-trace error page", async () => {
      const port = await getRandomPort("localhost");
      const child = runCli(["--prod", "--entry", entryFile, "--port", String(port)]);
      try {
        await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
        const res = await fetch(`http://localhost:${port}/boom`);
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain("Something went wrong");
        expect(body).not.toContain("BOOM_SECRET");
        expect(body).not.toMatch(/\n\s+at\s/); // no stack-trace frames
      } finally {
        child.kill("SIGTERM");
        await child.catch(() => {});
      }
    });

    it("dev mode still shows the stack trace", async () => {
      const port = await getRandomPort("localhost");
      const child = runCli(["--entry", entryFile, "--port", String(port)], {
        env: { NODE_ENV: "development" },
      });
      try {
        await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
        const res = await fetch(`http://localhost:${port}/boom`);
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain("BOOM_SECRET");
      } finally {
        child.kill("SIGTERM");
        await child.catch(() => {});
      }
    });
  });

  // The loader intercepts an entry's own `serve()` call before the adapter ever
  // resolves TLS, so the CLI has to forward the intercepted options itself.
  // Dropping them served TLS/mTLS entries over plaintext HTTP with no warning.
  describe("serve mode: TLS from an intercepted serve() call", () => {
    const tlsEnv = { SRVX_TEST_CERT: tlsCert.cert, SRVX_TEST_KEY: tlsCert.key };

    it("a nested `serve({ tls })` entry is served over HTTPS, not plaintext", async () => {
      await withServedCli(["--prod", "--entry", tlsEntryFile], { env: tlsEnv }, async (port) => {
        const dispatcher = clientAgent();
        try {
          const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher });
          expect(res.status).toBe(200);
          // `mwCount: 1` pins that the entry's middleware is not double-applied:
          // it is already folded into the intercepted server's composed `fetch`.
          expect(await res.json()).toMatchObject({ ok: true, mwCount: 1 });
        } finally {
          await dispatcher.close();
        }
        // ...and the same port must not answer plain HTTP any more.
        await expect(undiciFetch(`http://localhost:${port}/`)).rejects.toThrow();
      });
    });

    it("`--tls --cert --key` still overrides a nested `serve({ tls })`", async () => {
      // The nested cert is unusable; the run only succeeds if the CLI flags win.
      const certFile = fileURLToPath(new URL("./.tmp/tls/server.crt", import.meta.url));
      const keyFile = fileURLToPath(new URL("./.tmp/tls/server.key", import.meta.url));
      await withServedCli(
        ["--prod", "--entry", tlsEntryFile, "--tls", "--cert", certFile, "--key", keyFile],
        { env: { SRVX_TEST_CERT: "/nonexistent.crt", SRVX_TEST_KEY: "/nonexistent.key" } },
        async (port) => {
          const dispatcher = clientAgent();
          try {
            const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher });
            expect(res.status).toBe(200);
          } finally {
            await dispatcher.close();
          }
        },
      );
    });

    it("mTLS: the client certificate reaches the handler through the CLI", async () => {
      await withServedCli(
        ["--prod", "--entry", tlsEntryFile],
        {
          env: {
            ...tlsEnv,
            SRVX_TEST_CA: tlsCert.ca,
            SRVX_TEST_REJECT_UNAUTHORIZED: "false",
          },
        },
        async (port) => {
          const withCert = clientAgent({ withClientCert: true });
          try {
            const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher: withCert });
            expect(await res.json()).toMatchObject({
              authorized: true,
              subjectCN: "Test Client",
            });
          } finally {
            await withCert.close();
          }
          const withoutCert = clientAgent();
          try {
            const res = await undiciFetch(`https://localhost:${port}/`, {
              dispatcher: withoutCert,
            });
            expect(await res.json()).toMatchObject({ authorized: false });
          } finally {
            await withoutCert.close();
          }
        },
      );
    });

    it("mTLS: rejectUnauthorized (default) is enforced at the handshake", async () => {
      await withServedCli(
        ["--prod", "--entry", tlsEntryFile],
        { env: { ...tlsEnv, SRVX_TEST_CA: tlsCert.ca } },
        async (port) => {
          const withoutCert = clientAgent();
          try {
            await expect(
              undiciFetch(`https://localhost:${port}/`, { dispatcher: withoutCert }),
            ).rejects.toThrow();
          } finally {
            await withoutCert.close();
          }
          const withCert = clientAgent({ withClientCert: true });
          try {
            const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher: withCert });
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ authorized: true });
          } finally {
            await withCert.close();
          }
        },
      );
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
