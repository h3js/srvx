import type { Server, ServerRequest, ServerHandler, ServerMiddleware } from "./types.ts";

export function wrapFetch(server: Server): ServerHandler {
  const fetchHandler = server.options.fetch;
  const middleware = server.options.middleware || [];
  // Initialize `request.context` once here (shared by every adapter) so the
  // documented `request.context.user = ...` API works without each adapter
  // having to set it. `??=` keeps any context an upstream layer already set.
  return middleware.length === 0
    ? (request) => {
        request.context ??= {};
        return fetchHandler(request);
      }
    : (request) => {
        request.context ??= {};
        return callMiddleware(request, fetchHandler, middleware, 0);
      };
}

function callMiddleware(
  request: ServerRequest,
  fetchHandler: ServerHandler,
  middleware: ServerMiddleware[],
  index: number,
): Response | Promise<Response> {
  if (index === middleware.length) {
    return fetchHandler(request);
  }
  return middleware[index](request, () =>
    callMiddleware(request, fetchHandler, middleware, index + 1),
  );
}
