import { serve } from "@hono/node-server";

serve({
  overrideGlobalObjects: true,
  fetch(req) {
    return new Response("Hello!", {
      headers: { "x-test": req.headers.get("x-test") },
    });
  },
});
