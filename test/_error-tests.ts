import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";

const testDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * F9 (error paths): spawn `_error-fixture.ts` (a server with **no** `error`
 * option) under the given runtime and assert that an unhandled handler throw
 * does not take the process down and the client still gets a response.
 *
 * All three runtimes answer an uncaught handler error with a `500` and keep
 * serving -- Deno and Bun via their runtime-level catch, Node via the adapter
 * (#244). Only a spawned process can prove the "does not crash" half; the
 * in-process assertions for Node live in `node-error-paths.test.ts`.
 */
export function addExecUnhandledThrowTests(cmd: string): void {
  let childProc: ExecaRes;
  let baseURL: string;
  let exited = false;

  beforeAll(async () => {
    const port = await getRandomPort("localhost");
    baseURL = `http://localhost:${port}/`;
    const [bin, ...args] = cmd.replace("./", testDir).split(" ");
    childProc = execa(bin, args, { env: { PORT: port.toString() } });
    // Ignore the non-zero exit / SIGTERM that teardown provokes.
    childProc.catch(() => {});
    childProc.on("exit", () => {
      exited = true;
    });
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
  });

  afterAll(async () => {
    await childProc.kill();
  });

  for (const path of ["/throw", "/throw-async"]) {
    test(`unhandled throw at ${path} returns 500 without crashing`, async () => {
      const res = await fetch(baseURL + path.slice(1));
      // Deno and Bun answer an uncaught handler error with a 500.
      expect(res.status).toBe(500);
      await res.text().catch(() => {});
      // The process is still alive: a follow-up request succeeds.
      expect(exited).toBe(false);
      const ok = await fetch(baseURL);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("ok");
    });
  }
}
