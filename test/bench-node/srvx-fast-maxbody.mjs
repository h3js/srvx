import { serve, FastResponse } from "srvx";
import { fetchHandler } from "./_handler.mjs";

globalThis.Response = FastResponse;

serve({
  port: 3000,
  silent: true,
  // Large enough to never trigger, so this measures the per-request/per-chunk
  // enforcement overhead on the fast path, not the rejection path.
  maxRequestBodySize: 100 * 1024 * 1024,
  fetch: fetchHandler,
});
