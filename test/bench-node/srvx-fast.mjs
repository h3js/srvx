import { serve, FastResponse } from "srvx";
import { fetchHandler } from "./_handler.mjs";

globalThis.Response = FastResponse;

serve({
  port: 3000,
  silent: true,
  fetch: fetchHandler,
});
