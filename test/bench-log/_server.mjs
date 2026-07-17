// Benchmark target for `test/bench-log/_run.mjs`.
//
// The only variable is whether the `log()` middleware is installed:
//   IMPL=none  → no middleware (baseline: what the server does without logging)
//   IMPL=log   → the `srvx/log` middleware
//
// The runner controls the sink (where the logged lines go) by redirecting this
// process's stdout — see `_run.mjs`. Readiness is reported on stderr so it never
// contaminates a stdout sink that the benchmark is measuring.
import { writeSync } from "node:fs";
import { serve } from "srvx";
import { log } from "srvx/log";

const middleware = process.env.IMPL === "log" ? [log()] : [];

const server = await serve({
  port: 3000,
  silent: true,
  middleware,
  fetch: () => new Response("ok"),
});

await server.ready();
writeSync(2, "ready\n");
