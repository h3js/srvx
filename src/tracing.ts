import type { Server, ServerRequest, ServerPlugin, ServerMiddleware } from "./types.ts";
import { kMiddlewareInterceptor, type MiddlewareInterceptor } from "./_middleware.ts";

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
 * allowing you to subscribe to `srvx.request` and `srvx.middleware` tracing channels.
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
      const fetchChannel = tracingChannel<RequestEvent, RequestEvent>("srvx.request");
      const originalFetch = server.options.fetch;
      server.options.fetch = (request) => {
        return fetchChannel.tracePromise(async () => await originalFetch(request), {
          request,
          server,
        });
      };
    }

    // Trace middleware.
    //
    // Rather than snapshotting and rewrapping `server.options.middleware` here (at
    // plugin time), install a per-middleware interceptor that runs at dispatch time
    // over the *live* chain. Internal plugins (`trustProxy`, `error`, graceful
    // shutdown) unshift their middleware after user plugins run, so a snapshot taken
    // now would miss them and freeze stale indices. The interceptor sees the final
    // chain: every middleware is traced and `index` reflects its real position.
    if (opts.middleware !== false) {
      const middlewareChannel = tracingChannel<RequestEvent, RequestEvent>("srvx.middleware");
      const interceptor: MiddlewareInterceptor = (handler, index, request, next) => {
        const middleware = Object.freeze({ index, handler });
        return middlewareChannel.tracePromise(async () => await handler(request, next), {
          request: request as ServerRequest,
          server,
          middleware,
        });
      };
      (server as { [kMiddlewareInterceptor]?: MiddlewareInterceptor })[kMiddlewareInterceptor] =
        interceptor;
    }
  };
}
