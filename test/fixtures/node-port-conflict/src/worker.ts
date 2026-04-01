import { parentPort, workerData } from "node:worker_threads";

const { serve } = await import("../../../../src/adapters/node.ts");
const { host, port } = workerData as { host: string; port: number };

const server = serve({
  port,
  hostname: host,
  fetch() {
    return new Response("ok");
  },
});

try {
  await server.ready();
  parentPort?.postMessage({ type: "ready" });
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    code: (error as NodeJS.ErrnoException | undefined)?.code,
  });
} finally {
  await server.close().catch(() => {});
}
