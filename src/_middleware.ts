import type {
  Server,
  ServerRequest,
  ServerHandler,
  ServerMiddleware,
} from "./types.ts";

export function wrapFetch(server: Server): ServerHandler {
  const fetchHandler = server.options.fetch;
  const middleware = server.options.middleware || [];
  return middleware.length === 0
    ? fetchHandler
    : (request) => callMiddleware(request, fetchHandler, middleware, 0);
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
