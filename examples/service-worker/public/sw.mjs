import { serve } from "https://esm.sh/srvx";

serve({
  serviceWorker: { url: import.meta.url },
  fetch(_request) {
    return new Response(`<h1>👋 Hello there!</h1>`, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  },
});
