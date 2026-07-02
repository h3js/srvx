import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";

const testDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Spawns `fixtures/max-body-server.ts` (maxRequestBodySize: 8) under the given runtime
 * command and asserts the limit is enforced end-to-end.
 */
export function maxRequestBodySizeTests(cmd: string): void {
  let childProc: ExecaRes;
  let baseURL: string;

  beforeAll(async () => {
    const port = await getRandomPort("localhost");
    baseURL = `http://localhost:${port}/`;
    const [bin, ...args] = cmd.replace("./", testDir).split(" ");
    childProc = execa(bin, args, { env: { PORT: port.toString() } });
    childProc.catch((error) => {
      if (error.signal !== "SIGTERM") console.error(error);
    });
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
  });

  afterAll(async () => {
    await childProc?.kill();
  });

  test("rejects a body larger than maxRequestBodySize with 413", async () => {
    const res = await fetch(baseURL, { method: "POST", body: "0123456789" });
    expect(res.status).toBe(413);
    await res.body?.cancel();
  });

  test("accepts a body within maxRequestBodySize", async () => {
    const res = await fetch(baseURL, { method: "POST", body: "hi" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK:2");
  });
}
