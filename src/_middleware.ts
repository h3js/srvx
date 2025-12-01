import type {
  Server,
  ServerRequest,
  ServerHandler,
  ServerMiddleware,
} from "./types.ts";

export function wrapFetch(server: Server): ServerHandler {
  const fetchHandler = server.options.fetch;
  const middleware = server.options.middleware || [];

  if (middleware.length === 0) {
    return fetchHandler;
  }

  return (request) => callMiddleware(request, fetchHandler, middleware, 0);
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

  const currentMiddleware = middleware[index];
  const next = () =>
    callMiddleware(request, fetchHandler, middleware, index + 1);

  return currentMiddleware(request, next);
}
