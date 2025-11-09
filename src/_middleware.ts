import { traceCall } from "./tracing.ts";
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
    return (request) =>
      traceCall("fetch", async () => await fetchHandler(request), {
        request,
        server,
      });
  }

  return (request) =>
    callMiddleware(server, request, fetchHandler, middleware, 0);
}

function callMiddleware(
  server: Server,
  request: ServerRequest,
  fetchHandler: ServerHandler,
  middleware: ServerMiddleware[],
  index: number,
): Response | Promise<Response> {
  if (index === middleware.length) {
    return traceCall("fetch", async () => await fetchHandler(request), {
      request,
      server,
    });
  }

  const currentMiddleware = middleware[index];
  const next = () =>
    callMiddleware(server, request, fetchHandler, middleware, index + 1);

  return traceCall(
    "middleware",
    async () => await currentMiddleware(request, next),
    {
      request,
      server,
      index,
      name: currentMiddleware?.name,
    },
  );
}
