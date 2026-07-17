import { type Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type NodeHttp from "node:http";
import type { NodeServerResponse } from "../../types.ts";
import type { NodeResponse } from "./response.ts";

/**
 * Sends a web `Response` to a Node.js `ServerResponse`.
 *
 * The returned promise resolves once the response has been fully sent
 * (kept for `toNodeHandler` consumers that await completion).
 */
export function sendNodeResponse(
  nodeRes: NodeServerResponse,
  webRes: Response | NodeResponse,
): Promise<void> {
  try {
    return _sendNodeResponse(nodeRes, webRes, false) || Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Fire-and-forget variant for the internal `serve()` path: node:http ignores
 * the request listener's return value, so tracking `end()` completion with a
 * per-response Promise (and the microtask hops to settle it) is pure overhead
 * there. Streaming bodies still return their tracking promise (it drives
 * their own cleanup).
 *
 * A synchronous throw during serialization (e.g. an invalid header value in
 * `writeHead`) must not escape the request listener — that would surface as an
 * `uncaughtException` and take the process down. Guard it here and fail the
 * single response instead.
 *
 * @internal
 */
export function sendNodeResponseDetached(
  nodeRes: NodeServerResponse,
  webRes: Response | NodeResponse,
  silent?: boolean,
): Promise<void> | void {
  try {
    return _sendNodeResponse(nodeRes, webRes, true);
  } catch (error) {
    handleSendError(nodeRes, error, silent);
  }
}

function handleSendError(nodeRes: NodeServerResponse, error: unknown, silent?: boolean): void {
  // A synchronous throw here is almost always a serialization bug (e.g. an
  // invalid header name/value passed to `writeHead`). Without a diagnostic the
  // client just sees a bare 500 with no way to trace the cause. Surface the
  // underlying error on the server (unless silenced) while keeping the client
  // response detail-free.
  if (!silent) {
    console.error("[srvx] Failed to send response:", error);
  }
  failResponse(nodeRes);
}

/**
 * Answers an error that escaped the fetch handler with a bare 500.
 *
 * Bun and Deno both back their handler with a runtime-level catch that answers
 * 500 and keeps serving; node:http has no equivalent, so an escaping error
 * becomes a process-level `uncaughtException`/`unhandledRejection` (fatal for
 * an unguarded process) and leaves the client socket hanging until it times
 * out. Catching here keeps the default path consistent across runtimes.
 *
 * Mostly reached when no `error` option is set, since `errorPlugin` otherwise
 * handles the error as middleware first — but it also backstops an `error`
 * handler that throws itself.
 *
 * @internal
 */
export function sendErrorResponse(
  nodeRes: NodeServerResponse,
  error: unknown,
  silent?: boolean,
): void {
  // Mirrors the Bun/Deno default of logging the cause server-side; the client
  // response stays detail-free.
  if (!silent) {
    console.error("[srvx] Unhandled error in fetch handler:", error);
  }
  failResponse(nodeRes);
}

function failResponse(nodeRes: NodeServerResponse): void {
  if (nodeRes.writableEnded) {
    // Response already complete (e.g. the handler wrote directly to
    // `req.runtime.node.res` and then failed) — nothing left to answer with.
    return;
  }
  if (nodeRes.headersSent) {
    // Status line already committed — the only recovery is to tear down the socket.
    nodeRes.destroy();
  } else {
    nodeRes.statusCode = 500;
    nodeRes.end();
  }
}

function _sendNodeResponse(
  nodeRes: NodeServerResponse,
  webRes: Response | NodeResponse,
  detached: boolean,
): Promise<void> | void {
  if (!webRes) {
    nodeRes.statusCode = 500;
    return endNodeResponse(nodeRes, detached);
  }

  // Fast path for NodeResponse
  if ((webRes as NodeResponse)._toNodeResponse) {
    const res = (webRes as NodeResponse)._toNodeResponse();
    if (res.body) {
      if (res.body instanceof ReadableStream) {
        writeHead(nodeRes, res.status, res.statusText, res.headers);
        return streamBody(res.body, nodeRes);
      } else if (typeof (res.body as NodeReadable)?.pipe === "function") {
        // Defer writeHead so pipeBody can detect early stream errors
        return pipeBody(res.body as NodeReadable, nodeRes, res.status, res.statusText, res.headers);
      }
      writeHead(nodeRes, res.status, res.statusText, res.headers);
      // Note: NodeHttp2ServerResponse.write() body type declared as string | Uint8Array
      // We explicitly test other types in runtime.
      (nodeRes as NodeHttp.ServerResponse).write(res.body);
    } else {
      writeHead(nodeRes, res.status, res.statusText, res.headers);
    }
    return endNodeResponse(nodeRes, detached);
  }

  const rawHeaders: string[] = [];
  for (const [key, value] of webRes.headers) {
    rawHeaders.push(key, value);
  }
  writeHead(nodeRes, webRes.status, webRes.statusText, rawHeaders);

  return webRes.body ? streamBody(webRes.body, nodeRes) : endNodeResponse(nodeRes, detached);
}

function writeHead(
  nodeRes: NodeServerResponse,
  status: number,
  statusText: string,
  // Node.js writeHead accepts a raw array of [key, value, key, value] or [[key, value], [key, value]]
  // https://github.com/nodejs/node/blob/v22.14.0/lib/_http_server.js#L376
  // https://github.com/nodejs/node/blob/v24.10.0/lib/_http_outgoing.js#L417
  // But it has an inconsistency in slow-path that does not unflattens!!
  // https://github.com/h3js/srvx/pull/40
  // We always pass the (safe) flat form, pre-built to avoid a per-response flatten.
  rawHeaders: string[],
): void {
  if (!nodeRes.headersSent) {
    if (nodeRes.req?.httpVersion === "2.0") {
      // @ts-expect-error
      nodeRes.writeHead(status, rawHeaders);
    } else {
      // @ts-expect-error
      nodeRes.writeHead(status, statusText, rawHeaders);
    }
  }
}

function endNodeResponse(nodeRes: NodeServerResponse, detached?: boolean): Promise<void> | void {
  if (detached) {
    nodeRes.end();
    return;
  }
  return new Promise<void>((resolve) => nodeRes.end(resolve));
}

function pipeBody(
  stream: NodeReadable,
  nodeRes: NodeServerResponse,
  status: number,
  statusText: string,
  headers: string[],
): Promise<void> | void {
  if (nodeRes.destroyed) {
    stream.destroy?.();
    return;
  }

  // Duck-typed pipe objects (e.g. React's PipeableStream) only have .pipe()
  // and don't support pipeline() — use the raw path.
  if (typeof stream.on !== "function" || typeof stream.destroy !== "function") {
    writeHead(nodeRes, status, statusText, headers);
    stream.pipe(nodeRes as unknown as NodeJS.WritableStream);
    return new Promise<void>((resolve) => nodeRes.on("close", resolve));
  }

  // Real Node.js streams support pipeline() for proper error/abort propagation.
  // Wait for the first event (readable or error) before writing headers so that
  // if the stream errors before producing any data we can respond with 500
  // instead of committing to the original status code.

  // Stream already destroyed/errored — neither 'readable' nor 'error' would fire.
  if (stream.destroyed) {
    writeHead(nodeRes, 500, "Internal Server Error", []);
    return endNodeResponse(nodeRes);
  }

  return new Promise<void>((resolve) => {
    function onEarlyError() {
      stream.off("readable", onReadable);
      stream.destroy();
      writeHead(nodeRes, 500, "Internal Server Error", []);
      (endNodeResponse(nodeRes) as Promise<void>).then(resolve);
    }
    function onReadable() {
      stream.off("error", onEarlyError);
      if (nodeRes.destroyed) {
        stream.destroy();
        return resolve();
      }
      writeHead(nodeRes, status, statusText, headers);
      pipeline(stream, nodeRes as NodeHttp.ServerResponse)
        .catch(() => {})
        .then(() => resolve());
    }
    stream.once("error", onEarlyError);
    stream.once("readable", onReadable);
  });
}

export function streamBody(
  stream: ReadableStream,
  nodeRes: NodeServerResponse,
): Promise<void> | void {
  // stream is already destroyed
  if (nodeRes.destroyed) {
    stream.cancel().catch(() => {});
    return;
  }

  // HEAD responses must carry no body. Cancel the stream immediately instead of
  // pumping it to completion — an unbounded body (e.g. an SSE stream) would
  // otherwise pump forever. Headers are already written by the caller; just end
  // the response. Matches Deno/Bun, which discard the body for HEAD.
  if ((nodeRes as NodeHttp.ServerResponse).req?.method === "HEAD") {
    stream.cancel().catch(() => {});
    return endNodeResponse(nodeRes);
  }

  const reader = stream.getReader();

  // Cancel the stream and destroy the response
  function streamCancel(error?: Error) {
    reader.cancel(error).catch(() => {});
    if (error) {
      nodeRes.destroy(error);
    }
  }

  function streamHandle({
    done,
    value,
  }: ReadableStreamReadResult<Uint8Array>): void | Promise<void> {
    try {
      if (done) {
        // End the response
        nodeRes.end();
      } else if ((nodeRes as NodeHttp.ServerResponse).write(value)) {
        // Continue reading recursively
        reader.read().then(streamHandle, streamCancel);
      } else {
        // Wait for the drain event to continue reading
        nodeRes.once("drain", () => reader.read().then(streamHandle, streamCancel));
      }
    } catch (error) {
      streamCancel(error instanceof Error ? error : undefined);
    }
  }

  // Listen for close and error events to cancel the stream
  nodeRes.on("close", streamCancel);
  nodeRes.on("error", streamCancel);
  reader.read().then(streamHandle, streamCancel);

  // Return a promise that resolves when the stream is closed
  return reader.closed.catch(streamCancel).finally(() => {
    // cleanup listeners
    nodeRes.off("close", streamCancel);
    nodeRes.off("error", streamCancel);
  });
}
