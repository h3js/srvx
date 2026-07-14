import { serve } from "https://esm.sh/srvx";

serve({
  serviceWorker: { url: import.meta.url },
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response(`<h1>👋 Hello there!</h1>`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }
    // Fall back to the network for anything else (e.g. the worker script).
    return new Response("Not Found", { status: 404 });
  },
});
