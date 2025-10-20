import { serve } from "@hono/node-server";
import { fetchHandler } from "./_handler.mjs";

serve({
  overrideGlobalObjects: false,
  fetch: fetchHandler,
});
