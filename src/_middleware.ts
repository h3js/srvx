import type { Server, ServerHandler } from "./types.ts";

export function wrapFetch(server: Server): ServerHandler {
  // Fold the middleware into a composed handler once at construction time —
  // per-request cost is one `next` closure per layer, nothing else. Middleware
  // added to `server.options.middleware` after this point has no effect.
  let composed = server.options.fetch;
  const middleware = server.options.middleware;
  if (middleware) {
    for (let i = middleware.length - 1; i >= 0; i--) {
      const mw = middleware[i];
      const next = composed;
      composed = (request) => mw(request, () => next(request));
    }
  }
  return composed;
}
