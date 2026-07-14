import type { Server, ServerRequest, ServerHandler, ServerMiddleware } from "./types.ts";

/**
 * Internal per-middleware interceptor hook.
 *
 * When set on a server, {@link wrapFetch} invokes it for every middleware in the
 * live chain instead of calling the middleware directly, passing the handler and
 * its current index. Used by the experimental `srvx/tracing` plugin so that
 * tracing reflects the *final* middleware chain (including middleware that
 * internal plugins such as `trustProxy`/`error` add after user plugins run).
 *
 * @internal
 */
export const kMiddlewareInterceptor: unique symbol = Symbol.for("srvx.middlewareInterceptor");

/** @internal */
export type MiddlewareInterceptor = (
  handler: ServerMiddleware,
  index: number,
  request: ServerRequest,
  next: () => Response | Promise<Response>,
) => Response | Promise<Response>;

/**
 * Build the composed fetch handler for a server (middleware chain + fetch).
 *
 * The middleware chain is read **live** from `server.options.middleware` on every
 * request rather than snapshotted at construction. This makes the extension
 * contract consistent: middleware appended after construction via
 * `server.options.middleware.push(...)` — the mechanism plugins use — always take
 * effect, regardless of whether the array was empty or non-empty when the server
 * was created. Because plugins are synchronous (see `ServerPlugin`), every
 * plugin-registered middleware is in place before the first request.
 */
export function wrapFetch(server: Server): ServerHandler {
  const fetchHandler = server.options.fetch;
  return (request) => callMiddleware(request as ServerRequest, fetchHandler, server, 0);
}

function callMiddleware(
  request: ServerRequest,
  fetchHandler: ServerHandler,
  server: Server,
  index: number,
): Response | Promise<Response> {
  const middleware = server.options.middleware;
  if (!middleware || index >= middleware.length) {
    return fetchHandler(request);
  }
  const handler = middleware[index];
  const next = () => callMiddleware(request, fetchHandler, server, index + 1);
  const interceptor = (server as { [kMiddlewareInterceptor]?: MiddlewareInterceptor })[
    kMiddlewareInterceptor
  ];
  return interceptor ? interceptor(handler, index, request, next) : handler(request, next);
}
