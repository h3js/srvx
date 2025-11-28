import { tracingChannel, type TracingChannel } from "node:diagnostics_channel";
import type { Server, ServerRequest } from "./types.ts";

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
