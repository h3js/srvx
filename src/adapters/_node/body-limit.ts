import type { Socket } from "node:net";
import type { ServerResponse } from "node:http";
import type { Http2ServerRequest, ServerHttp2Stream } from "node:http2";
import type { NodeServerRequest, NodeServerResponse } from "../../types.ts";

// What happens to the connection once a request body went over the limit and
// the rest of it is still on the wire.
//
// HTTP/1.1 (RFC 9112 §9.3) requires the server to either read the whole body
// or close the connection after its response. Reading an over-limit body to the
// end defeats the limit, so the connection is closed: the response carries
// `Connection: close` (§9.6), and once it is sent the write side is shut and
// whatever the client still sends is read and dropped for a short while before
// the socket is destroyed ("lingering close", §9.6). Without that last step a
// client that uploads the whole body before reading — which most simple clients
// do — would be cut off by a TCP reset and never see the 413.
//
// The linger is capped so a client cannot keep the connection busy:
//
// - `LINGER_BYTES` (1 MiB): enough for the tail of a moderately oversized
//   upload (the kernel buffers on both ends hold more on top), small next to
//   the limits it applies to. A client still sending past it is not reading.
// - `LINGER_MS` (1 s): a client that is reading has the response and stops
//   sending (or closes) within a round trip; one that keeps sending for longer
//   gets the reset it would have got anyway.
//
// HTTP/2 multiplexes, so only the stream goes: RST_STREAM(NO_ERROR) after the
// complete response tells the client to stop sending that body (RFC 9113 §8.1)
// and leaves the other streams on the session alone.

const LINGER_BYTES = 1024 * 1024;
const LINGER_MS = 1000;

const kLingering = /* @__PURE__ */ Symbol("srvx.lingering");

/**
 * Called when `req`'s body went over the size limit before it was fully read:
 * closes the HTTP/1 connection, or resets the HTTP/2 stream, once `res` has been
 * sent (see above). Idempotent; a no-op for a body that has fully arrived.
 */
export function onBodyLimitExceeded(req: NodeServerRequest, res?: NodeServerResponse): void {
  if (!res || req.complete || (req as any)[kLingering]) {
    return;
  }
  (req as any)[kLingering] = true;

  const stream = (req as Http2ServerRequest).stream as ServerHttp2Stream | undefined;
  if (stream) {
    // `Http2ServerResponse` only emits `finish` once the stream closes, which a
    // half-read upload never lets happen — wait on the stream's own writable side.
    if (stream.writableFinished) {
      resetStream(stream);
    } else {
      stream.once("finish", () => resetStream(stream));
    }
    return;
  }

  const http1Res = res as ServerResponse;
  // The response holds the socket until it is sent, the request after that;
  // either may have dropped it (`Readable.toWeb()` cancellation nulls `req.socket`).
  const socket = http1Res.socket ?? req.socket;
  if (!socket || socket.destroyed) {
    return;
  }
  // The limit can trip while the parser is still working through a read that
  // also holds the end of the body (and maybe a pipelined request), with the
  // handler's response running in between (each parser callback drains the
  // microtask queue). The body is then complete, and the connection fine to
  // keep. So `Connection: close` is only decided once that read is parsed:
  // `settleRequestBody()` holds the response head back that long; a head
  // written without passing there gets the same check here. Whether to linger
  // is checked again once the response is sent.
  if (!http1Res.headersSent) {
    setImmediate(closeAfterResponse, req, http1Res);
  }
  const onFinish = () => {
    if (!req.complete) {
      lingeringClose(socket);
    }
  };
  if (http1Res.writableFinished) {
    onFinish();
  } else {
    http1Res.once("finish", onFinish);
  }
}

/**
 * Marks the response `Connection: close` while the over-limit body is still
 * incomplete. A `Connection` header the handler set itself wins (Node's rule):
 * an explicit `keep-alive` is advertised, but the connection still closes.
 */
function closeAfterResponse(req: NodeServerRequest, res: ServerResponse): void {
  if (!req.complete && !res.headersSent) {
    res.shouldKeepAlive = false;
  }
}

function resetStream(stream: ServerHttp2Stream): void {
  if (stream.closed) {
    return;
  }
  // `close()` sends RST_STREAM with its default code, `NGHTTP2_NO_ERROR`.
  stream.close();
  // A stream closed with NO_ERROR is only destroyed once its readable side
  // ends, and nothing reads it anymore: the compat request it feeds is paused
  // (or destroyed, which pauses the stream on every chunk). Drop what is
  // buffered so it can end.
  stream.removeAllListeners("data");
  stream.resume();
}

// Runs after Node's own `finish` handler (`resOnFinish`, registered first),
// which has already scheduled a `destroySoon()` for a `Connection: close`
// response — destroying the socket the moment the response is flushed, with the
// unread upload still in the receive buffer.
function lingeringClose(socket: Socket): void {
  if (socket.destroyed) {
    return;
  }
  socket.removeListener("finish", socket.destroy);
  // Shut the write side: no response follows this one (RFC 9112 §9.6).
  socket.end();
  let received = 0;
  const destroy = () => socket.destroy();
  const timer = setTimeout(destroy, LINGER_MS).unref();
  socket.once("close", () => clearTimeout(timer));
  // Take the socket off the HTTP parser, so nothing sent after the body is
  // parsed or dispatched as another request (§9.6), and drop what arrives.
  // (This drops any other `data` listener too; the connection is done.)
  socket.removeAllListeners("data");
  // Restart reading (the parser stopped it when the request stream backed up)
  // while the server's own `resume` handler is still attached: when the parser
  // reads the handle directly, that handler is what restarts it. It runs on the
  // next tick, before any I/O, so the parser sees none of it. Adding a `data`
  // listener afterwards is what moves the handle's data from the parser to JS.
  socket.resume();
  process.nextTick(() => {
    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > LINGER_BYTES) {
        destroy();
      }
    });
    // The parser stopped mid-body; a client closing now (the usual reaction to
    // the response) would make the server's `end` handler report a parse error
    // (`clientError`) for it. A paused parser finishes cleanly.
    (socket as Socket & { parser?: { pause?: () => void } }).parser?.pause?.();
  });
}

/**
 * Runs before the response head is written; when it returns a promise, the
 * head waits for it. `now` is for a head the caller cannot hold back (an error
 * the host server answers).
 *
 * - A body that went over a limit: `Connection: close` unless it has arrived
 *   whole once the current read is parsed (see `onBodyLimitExceeded()`).
 * - With `maxRequestBodySize` set, a body the handler never read: Node reads such
 *   a body to the end after the response to keep the connection alive, whatever
 *   its size. A declared `Content-Length` over the limit is handled like a read
 *   that went over it; a chunked body is counted while it is drained. (HTTP/2
 *   needs nothing: Node already resets a stream whose body was not read.)
 */
export function settleRequestBody(
  req: NodeServerRequest,
  res: NodeServerResponse,
  maxRequestBodySize: number | undefined,
  now?: boolean,
): Promise<void> | undefined {
  if ((req as any)[kLingering]) {
    return decideClose(req, res, now);
  }
  // No limit; fully arrived; being (or already) read by someone; or HTTP/2.
  if (
    maxRequestBodySize === undefined ||
    req.complete ||
    req.readableFlowing !== null ||
    req.destroyed ||
    "stream" in req
  ) {
    return;
  }
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (Number(contentLength) > maxRequestBodySize) {
      onBodyLimitExceeded(req, res);
      return decideClose(req, res, now);
    }
    return; // At most `maxRequestBodySize` bytes for Node to drain.
  }
  if (req.headers["transfer-encoding"] === undefined) {
    return; // No body.
  }
  let size = 0;
  const cleanup = () => {
    req.off("data", onData);
    req.off("end", cleanup);
    req.off("close", cleanup);
  };
  const onData = (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > maxRequestBodySize) {
      cleanup();
      req.pause();
      onBodyLimitExceeded(req, res);
    }
  };
  req.on("data", onData).once("end", cleanup).once("close", cleanup);
}

function decideClose(
  req: NodeServerRequest,
  res: NodeServerResponse,
  now: boolean | undefined,
): Promise<void> | undefined {
  if ("stream" in req || req.complete || res.headersSent) {
    return;
  }
  if (now) {
    closeAfterResponse(req, res as ServerResponse);
    return;
  }
  return new Promise((resolve) =>
    setImmediate(() => {
      closeAfterResponse(req, res as ServerResponse);
      resolve();
    }),
  );
}
