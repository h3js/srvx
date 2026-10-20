import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { Agent, fetch } from "undici";
import { getTLSCert } from "./_utils.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

function get(socketPath: string): Promise<string> {
  return fetch("http://localhost/", {
    dispatcher: new Agent({ connect: { socketPath } }),
  }).then((res) => res.text());
}

function rawRequest(path: string, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => socket.end(head));
    let out = "";
    socket.on("data", (chunk) => (out += chunk.toString()));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}

/**
 * Spawns `fixtures/unix-socket-server.ts` under the given runtime command and
 * asserts the `unix` option is mapped to the runtime's native unix socket listener.
 */
export function unixSocketTests(cmd: string, opts: { tls: boolean; hostless: boolean }): void {
  let dir: string;
  let path: string;
  let childProc: ExecaRes | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "srvx-"));
    path = join(dir, "app.sock");
  });

  afterEach(async () => {
    childProc?.kill();
    childProc = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function start(env: Record<string, string> = {}) {
    const [bin, ...args] = cmd.replace("./", testDir).split(" ");
    // An invalid `PORT` proves `port` is not resolved when `unix` is set.
    childProc = execa(bin, args, {
      env: { SOCKET_PATH: path, PORT: "invalid", ...env },
      reject: false,
    });
    return childProc;
  }

  function waitForLine(proc: ExecaRes, prefix: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = "";
      proc.stdout!.on("data", (chunk) => {
        out += chunk.toString();
        const line = out.split("\n").find((l) => l.startsWith(prefix));
        if (line) resolve(line.slice(prefix.length));
      });
      proc.then((result) =>
        reject(new Error(`exited before printing "${prefix}":\n${result.stderr}`)),
      );
    });
  }

  const waitForURL = (proc: ExecaRes) => waitForLine(proc, "url=").then((s) => JSON.parse(s));

  test("listens on the unix socket and removes it on close", async () => {
    const proc = start();
    expect(await waitForURL(proc)).toBe(path);

    const res = await fetch("http://localhost/foo", {
      method: "POST",
      body: "hi",
      dispatcher: new Agent({ connect: { socketPath: path } }),
    });
    expect(await res.text()).toBe("ok http://localhost/foo http://localhost hi");

    if (opts.hostless) {
      // Without a `Host` header the URL falls back to `localhost`.
      const raw = await rawRequest(path, "GET /bar?x=1 HTTP/1.0\r\n\r\n");
      expect(raw).toMatch(/^HTTP\/1\.[01] 200 /);
      expect(raw).toContain("ok http://localhost/bar?x=1 http://localhost");
    }

    const closed = waitForLine(proc, "closed");
    proc.stdin!.write("close\n");
    await closed;
    expect(existsSync(path)).toBe(false);
    // e.g. Deno's `request.signal` legacy-behavior warning
    expect((await proc).stderr).toBe("");
  });

  test("removes a stale socket file left by a crashed process", async () => {
    const crash = `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`;
    await execa(process.execPath, ["-e", crash], { reject: false });
    expect(lstatSync(path).isSocket()).toBe(true);

    const proc = start();
    expect(await waitForURL(proc)).toBe(path);
    expect(await get(path)).toBe("ok http://localhost/ http://localhost");
  });

  test("keeps a socket that is still in use", async () => {
    const live = createServer((socket) => socket.end()).listen(path);
    await once(live, "listening");
    try {
      const result = await start();
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/EADDRINUSE|AddrInUse/);
      expect(lstatSync(path).isSocket()).toBe(true);
    } finally {
      live.close();
    }
  });

  test("never removes a regular file at the path", async () => {
    await writeFile(path, "data");
    const result = await start();
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("data");
  });

  test("listens on a random socket with `unix: true`", async () => {
    const proc = start({ SOCKET_PATH: "true" });
    const url = await waitForURL(proc);
    // Linux: abstract socket (no file); elsewhere a file in the temp dir.
    expect(url).toMatch(
      process.platform === "linux" ? /^\0srvx-\d+-\w+\.sock$/ : /srvx-\d+-\w+\.sock$/,
    );
    expect(await get(url)).toBe("ok http://localhost/ http://localhost");
  });

  if (opts.tls) {
    test("serves TLS over the unix socket", async () => {
      const tls = await getTLSCert();
      const proc = start({ TLS_CERT: tls.cert, TLS_KEY: tls.key });
      expect(await waitForURL(proc)).toBe(path);

      const res = await fetch("https://localhost/", {
        dispatcher: new Agent({ connect: { socketPath: path, ca: tls.ca } }),
      });
      expect(await res.text()).toBe("ok https://localhost/ https://localhost");
    });
  } else {
    test("refuses TLS instead of serving plaintext", async () => {
      const tls = await getTLSCert();
      const result = await start({ TLS_CERT: tls.cert, TLS_KEY: tls.key });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("TLS is not supported on unix sockets");
      expect(existsSync(path)).toBe(false);
    });
  }
}
