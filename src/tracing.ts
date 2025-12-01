import { tracingChannel, type TracingChannel } from "node:diagnostics_channel";
import type {
  Server,
  ServerRequest,
  ServerPlugin,
  ServerMiddleware,
} from "./types.ts";

export type TraceDataMap = {
  fetch: { request: ServerRequest; server: Server };
  middleware: {
    request: ServerRequest;
    server: Server;
    index: number;
    name?: string;
  };
};

export type TraceChannelName = keyof TraceDataMap;

const channels: Record<
  TraceChannelName,
  TracingChannel<unknown, TraceDataMap[TraceChannelName]>
> = {
  fetch: tracingChannel("srvx.fetch"),
  middleware: tracingChannel("srvx.middleware"),
};

export function traceCall<
  TChannel extends TraceChannelName,
  TReturn,
  TData extends TraceDataMap[TChannel],
>(
  channel: TChannel,
  exec: () => Promise<TReturn>,
  data: TData,
): Promise<TReturn> {
  return channels[channel].tracePromise(exec, data);
}

export function traceSync<
  TChannel extends TraceChannelName,
  TReturn,
  TData extends TraceDataMap[TChannel],
>(channel: TChannel, exec: () => TReturn, data: TData): TReturn {
  return channels[channel].traceSync(exec, data);
}

/**
 * Tracing plugin that adds diagnostics channel tracing to middleware and fetch handlers.
 *
 * This plugin wraps all middleware and the fetch handler with tracing instrumentation,
 * allowing you to subscribe to `srvx.fetch` and `srvx.middleware` tracing channels.
 *
 * @example
 * ```ts
 * import { serve, tracingPlugin } from "srvx/node";
 *
 * const server = serve({
 *   fetch: (req) => new Response("OK"),
 *   middleware: [myMiddleware],
 *   plugins: [tracingPlugin],
 * });
 * ```
 */
export const tracingPlugin: ServerPlugin = (server) => {
  // Wrap middleware with tracing
  const originalMiddleware = server.options.middleware;
  const wrappedMiddleware: ServerMiddleware[] = originalMiddleware.map(
    (middleware, index) => {
      return (request, next) => {
        return traceCall(
          "middleware",
          async () => await middleware(request, next),
          {
            request,
            server,
            index,
            name: middleware?.name,
          },
        );
      };
    },
  );

  // Replace middleware array with wrapped versions
  server.options.middleware.splice(
    0,
    server.options.middleware.length,
    ...wrappedMiddleware,
  );

  // Wrap the fetch handler with tracing
  const originalFetch = server.options.fetch;
  server.options.fetch = (request) => {
    return traceCall("fetch", async () => await originalFetch(request), {
      request,
      server,
    });
  };
};
