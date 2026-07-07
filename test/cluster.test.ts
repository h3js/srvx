import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { get as httpGet } from "node:http";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";

const fixtureEntry = fileURLToPath(new URL("fixtures/cluster/server.mjs", import.meta.url));
const cliBin = fileURLToPath(new URL("../bin/srvx.mjs", import.meta.url));

const isLinux = process.platform === "linux";

// The CLI bin runs from dist, runtime suites need their binary available
const hasDist = existsSync(fileURLToPath(new URL("../dist/cli.mjs", import.meta.url)));
const hasBin = (bin: string) => {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

// Plain HTTP GET without keep-alive: a pooled fetch() connection would stick to
// a single worker and hide the round-robin distribution.
function fetchWorker(url: string): Promise<{ pid: number; worker: string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { agent: false, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          expect(res.statusCode).toBe(200);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error as Error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
  });
}

// Collect worker pids until `expected` distinct ones are seen (or timeout).
async function collectPids(url: string, expected: number, timeout = 8000): Promise<Set<number>> {
  const pids = new Set<number>();
  const deadline = Date.now() + timeout;
  while (pids.size < expected && Date.now() < deadline) {
    try {
      pids.add((await fetchWorker(url)).pid);
    } catch {
      // worker may be restarting; retry
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return pids;
}

function testClusterExec(cmd: string[], opts: { workers: number; lb: boolean }) {
  let childProc: ExecaRes;
  let url: string;

  beforeAll(async () => {
    const port = await getRandomPort("localhost");
    url = `http://localhost:${port}/`;
    childProc = execa(cmd[0], cmd.slice(1), {
      env: { PORT: port.toString(), SRVX_TEST_CLUSTER: String(opts.workers) },
    });
    childProc.catch(() => {}); // killed with SIGTERM on teardown
    if (process.env.TEST_DEBUG) {
      childProc.stdout!.on("data", (chunk) => console.log(chunk.toString()));
      childProc.stderr!.on("data", (chunk) => console.log(chunk.toString()));
    }
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
  });

  afterAll(async () => {
    childProc.kill("SIGTERM");
    await childProc.catch(() => {});
  });

  it("serves requests from cluster workers", async () => {
    const { worker } = await fetchWorker(url);
    expect(worker).not.toBeNull();
  });

  if (opts.lb) {
    it("load balances across all workers", async () => {
      const pids = await collectPids(url, opts.workers);
      expect(pids.size).toBe(opts.workers);
    });

    it("restarts crashed workers", async () => {
      const { pid: killedPid } = await fetchWorker(url);
      process.kill(killedPid, "SIGKILL");
      // Eventually all worker slots serve again, including a fresh process
      const deadline = Date.now() + 10_000;
      let pids = new Set<number>();
      while (Date.now() < deadline) {
        pids = await collectPids(url, opts.workers, 2000);
        if (pids.size === opts.workers && !pids.has(killedPid)) {
          break;
        }
      }
      expect(pids.size).toBe(opts.workers);
      expect(pids.has(killedPid)).toBe(false);
    });
  }

  it("shuts down all workers on SIGTERM", async () => {
    childProc.kill("SIGTERM");
    await childProc.catch(() => {});
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
}

describe("cluster (node, programmatic)", () => {
  // node:cluster round-robin load balances on all platforms
  testClusterExec(["node", fixtureEntry], { workers: 2, lb: true });
});

describe("cluster (node, options)", () => {
  async function spawnFixture(env: Record<string, string>) {
    const port = await getRandomPort("localhost");
    const proc = execa("node", [fixtureEntry], { env: { PORT: String(port), ...env } });
    proc.catch(() => {}); // killed with SIGTERM on teardown
    return { proc, port, url: `http://localhost:${port}/` };
  }

  it("SRVX_WORKERS env enables cluster mode", async () => {
    const { proc, port, url } = await spawnFixture({ SRVX_WORKERS: "2" });
    try {
      await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
      const pids = await collectPids(url, 2);
      expect(pids.size).toBe(2);
    } finally {
      await proc.kill();
    }
  });

  it("cluster: false disables cluster mode including SRVX_WORKERS", async () => {
    const { proc, port, url } = await spawnFixture({
      SRVX_WORKERS: "2",
      SRVX_TEST_CLUSTER: "false",
    });
    try {
      await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
      const { worker } = await fetchWorker(url);
      expect(worker).toBeNull();
    } finally {
      await proc.kill();
    }
  });

  it("supervisor exits with a non-zero code when workers fail to start", async () => {
    const port = await getRandomPort("localhost");
    const result = await execa("node", [fixtureEntry], {
      env: { PORT: String(port), SRVX_TEST_CLUSTER: "2", SRVX_TEST_CRASH: "1" },
      reject: false,
      timeout: 12_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe.skipIf(!hasDist)("cluster (node, cli)", () => {
  // --host=localhost: waitForPort can not detect a wildcard listener on macOS
  testClusterExec(
    ["node", cliBin, "--prod", "--cluster=2", "--host=localhost", "--entry", fixtureEntry],
    { workers: 2, lb: true },
  );
});

describe.skipIf(!hasBin("bun"))("cluster (bun)", () => {
  // SO_REUSEPORT load balancing is Linux-only for Bun
  testClusterExec(["bun", "run", fixtureEntry], { workers: 2, lb: isLinux });
});

describe.skipIf(!hasBin("deno"))("cluster (deno)", () => {
  // SO_REUSEPORT load balancing is Linux-only for Deno (single worker elsewhere)
  testClusterExec(["deno", "run", "-A", fixtureEntry], { workers: 2, lb: isLinux });
});
