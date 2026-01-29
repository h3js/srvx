import type { Server, ServerRequest, ServerPlugin, ServerMiddleware } from "./types.ts";

/**
 * @experimental Channel names, event types and config options may change in future releases.
 */
export type RequestEvent = {
  server: Server;
  request: ServerRequest;
  middleware?: {
    index: number;
    handler: ServerMiddleware;
  };
};

/**
 *
 * @experimental Channel names, event types and config options may change in future releases.
 *
 * Tracing plugin that adds diagnostics channel tracing to middleware and fetch handlers.
 *
 * This plugin wraps all middleware and the fetch handler with tracing instrumentation,
 * allowing you to subscribe to `srvx.fetch` and `srvx.middleware` tracing channels.
 *
 * @example
 * ```ts
 * import { serve } from "srvx";
 * import { tracingPlugin } from "srvx/tracing";
 *
 * const server = serve({
 *   fetch: (req) => new Response("OK"),
 *   middleware: [myMiddleware],
 *   plugins: [tracingPlugin()],
 * });
 * ```
 */
export function tracingPlugin(opts: { middleware?: boolean; fetch?: boolean } = {}): ServerPlugin {
  return (server) => {
    // No-op if tracingChannel is not available
    const { tracingChannel } =
      globalThis.process?.getBuiltinModule?.("node:diagnostics_channel") || {};
    if (!tracingChannel) {
      return;
    }

    // Wrap the fetch handler with tracing
    if (opts.fetch !== false) {
      const fetchChannel = tracingChannel<unknown, RequestEvent>("srvx.fetch");
      const originalFetch = server.options.fetch;
      server.options.fetch = (request) => {
        return fetchChannel.tracePromise(async () => await originalFetch(request), {
          request,
          server,
        });
      };
    }

    // Wrap middleware with tracing
    if (opts.middleware !== false) {
      const middlewareChannel = tracingChannel<unknown, RequestEvent>("srvx.middleware");
      const originalMiddleware = server.options.middleware;
      const wrappedMiddleware: ServerMiddleware[] = originalMiddleware.map((handler, index) => {
        const middleware = Object.freeze({ index, handler });
        return (request, next) => {
          return middlewareChannel.tracePromise(async () => await handler(request, next), {
            request,
            server,
            middleware,
          });
        };
      });

      // Replace middleware array with wrapped versions
      server.options.middleware.splice(0, server.options.middleware.length, ...wrappedMiddleware);
    }
  };
}
