import { ServerResponse } from "node:http";
import { WebRequestSocket, prematureCloseError } from "./socket.ts";
import type { WebIncomingMessage } from "./incoming.ts";

// Node's OutgoingMessage sets an internal `kNeedDrain` symbol to true when a
// write returns false, and clears it (emitting "drain") from the HTTP server's
// socketOnDrain handler. We don't have access to that symbol publicly, so we
// resolve it from the instance once and cache it. Resolving may fail across
// Node versions; in that case we fall back to always re-emitting "drain".
let needDrainSymbol: symbol | null | undefined;
function getNeedDrainSymbol(res: ServerResponse): symbol | null {
  if (needDrainSymbol === undefined) {
    needDrainSymbol =
      Object.getOwnPropertySymbols(res).find((s) => s.description === "kNeedDrain") ?? null;
  }
  return needDrainSymbol;
}

// Statuses that must not carry a response body per the Fetch/HTTP spec.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export class WebServerResponse extends ServerResponse {
  #socket: WebRequestSocket;
  #socketError?: Error;

  constructor(req: WebIncomingMessage, socket: WebRequestSocket) {
    super(req);
    this.assignSocket(socket);

    // `super(req)` enables chunked transfer-encoding by default because the
    // synthetic request now reports HTTP/1.1. But this response isn't written to
    // a real wire: `toWebResponse()` captures the raw body buffer from the
    // bridging socket and re-wraps it in a web `Response`. Chunk framing would
    // corrupt that captured body, so keep the output un-chunked (close-delimited).
    this.useChunkedEncodingByDefault = false;

    this.once("finish", () => {
      socket.end();
    });

    this.#socket = socket;

    // When the client disconnects, the assigned socket is destroyed (e.g. with
    // an AbortError) and emits "error"/"close" without the ServerResponse ever
    // emitting "finish" or "error". Attach this listener synchronously so the
    // socket error is consumed (instead of crashing the process as an unhandled
    // "error" event) and recorded for waitToFinish() to settle on.
    socket.once("error", (err) => {
      this.#socketError ??= err;
    });

    // Forward socket "drain" events to the response. Node's HTTP server does
    // this internally (socketOnDrain), but the manual assignSocket() path here
    // does not, so a handler awaiting res.once("drain") after a backpressured
    // write() would deadlock. See https://github.com/h3js/srvx/issues/208
    socket.on("drain", () => {
      const kNeedDrain = getNeedDrainSymbol(this);
      if (kNeedDrain && !(this as any)[kNeedDrain]) {
        return;
      }
      if (this.destroyed || this.writableFinished) {
        return;
      }
      if (kNeedDrain) {
        (this as any)[kNeedDrain] = false;
      }
      this.emit("drain");
    });

    // Express can override prototype so we have to bind methods
    this.waitToFinish = this.waitToFinish.bind(this);
    this.toWebResponse = this.toWebResponse.bind(this);
  }

  waitToFinish(): Promise<void> {
    if (this.writableFinished) {
      return Promise.resolve();
    }
    // The socket is destroyed before the response finished flushing (e.g. the
    // client aborted). `writableEnded` may still be true (end() was called) but
    // the response will never emit "finish", so resolving here would hand back a
    // body stream that never closes. Reject instead.
    if (this.#socketError || this.#socket.destroyed) {
      return Promise.reject(this.#socketError ?? prematureCloseError());
    }
    if (this.writableEnded) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const socket = this.#socket;
      const settle = (err?: Error) => {
        this.removeListener("finish", onFinish);
        this.removeListener("error", onError);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        if (err) reject(err);
        else resolve();
      };
      const onFinish = () => settle();
      const onError = (err: Error) => settle(err);
      const onClose = () => {
        if (!this.writableFinished) {
          settle(this.#socketError ?? prematureCloseError());
        }
      };
      this.on("finish", onFinish);
      this.on("error", onError);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
  }

  async toWebResponse(): Promise<Response> {
    await this.waitToFinish();

    const headers: [string, string][] = [];

    // this.getHeaders() is unreliable because it misses direct writeHead() calls
    const httpHeader = (this as any)._header?.split("\r\n");
    for (let i = 1; httpHeader && i < httpHeader.length; i++) {
      const sepIndex = httpHeader[i].indexOf(": ");
      if (sepIndex === -1) continue;
      const key = httpHeader[i].slice(0, Math.max(0, sepIndex));
      const value = httpHeader[i].slice(Math.max(0, sepIndex + 2));
      if (!key) continue;
      headers.push([key, value]);
    }

    // Null-body statuses (101, 204, 205, 304) cannot have a body; passing a
    // stream to `new Response()` for these throws, which would otherwise be
    // caught and surfaced as a 500 (e.g. Express `res.sendStatus(204)` or a
    // conditional-GET 304 through `toFetchHandler`).
    const nullBody = NULL_BODY_STATUSES.has(this.statusCode);
    return new Response(nullBody ? null : this.#socket._webResBody, {
      status: this.statusCode,
      statusText: this.statusMessage,
      headers: headers,
    });
  }
}
