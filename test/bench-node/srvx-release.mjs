import { serve } from "srvx-release";
import { fetchHandler } from "./_handler.mjs";

const server = await serve({
  port: 3000,
  silent: true,
  fetch: fetchHandler,
});

await server.ready();
