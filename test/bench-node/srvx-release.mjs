import { serve } from "srvx-release";

const server = await serve({
  port: 3000,
  silent: true,
  fetch(req) {
    return new Response("Hello!", {
      headers: { "x-test": req.headers.get("x-test") },
    });
  },
});

await server.ready();
