import { serve, FastResponse } from "srvx";

serve({
  port: 3000,
  silent: true,
  fetch(req) {
    return new FastResponse("Hello!", {
      headers: { "x-test": req.headers.get("x-test") },
    });
  },
});
