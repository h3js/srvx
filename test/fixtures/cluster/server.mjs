// Minimal cluster entry: the supervisor re-executes this file for each worker.
const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "node";
const { serve } = await import(`../../../src/adapters/${runtime}.ts`);

// Simulate a worker that can never start (crash-loop / fatal startup tests)
if (process.env.SRVX_TEST_CRASH && process.env.SRVX_CLUSTER_WORKER) {
  process.exit(7);
}

// `SRVX_TEST_CLUSTER`: worker count, "false" to disable, unset to leave the
// `cluster` option out (e.g. to test `SRVX_WORKERS` env activation).
const testCluster = process.env.SRVX_TEST_CLUSTER;

serve({
  cluster: testCluster === "false" ? false : testCluster ? Number(testCluster) : undefined,
  hostname: "localhost",
  fetch: () =>
    Response.json({
      pid: process.pid,
      worker: process.env.SRVX_CLUSTER_WORKER ?? null,
    }),
});
