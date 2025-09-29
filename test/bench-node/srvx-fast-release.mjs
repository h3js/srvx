import { serve, FastResponse } from "srvx-release";

serve({
  port: 3000,
  silent: true,
  fetch() {
    return new FastResponse("Hello!");
  },
});
