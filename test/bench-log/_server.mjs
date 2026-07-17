// Benchmark target for `test/bench-log/_run.mjs`.
//
// The only variable is which logging middleware is installed:
//   IMPL=none    → no middleware (baseline: the server with nothing to log)
//   IMPL=before  → the pre-batching `console.log`-per-request logger (`_before.mjs`)
//   IMPL=log     → the current `srvx/log` middleware
//
// The runner controls the sink (where the logged lines go) by redirecting this
// process's stdout — see `_run.mjs`. Readiness is reported on stderr so it never
// contaminates a stdout sink that the benchmark is measuring.
import { writeSync } from "node:fs";
import { serve } from "srvx";

const impl = process.env.IMPL;
const middleware = [];
if (impl === "before") {
  const { log } = await import("./_before.mjs");
  middleware.push(log());
} else if (impl === "log") {
  const { log } = await import("srvx/log");
  middleware.push(log());
}

const server = await serve({
  port: 3000,
  silent: true,
  middleware,
  fetch: () => new Response("ok"),
});

await server.ready();
writeSync(2, "ready\n");
