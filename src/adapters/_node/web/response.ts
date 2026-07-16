import { ServerResponse } from "node:http";
import { WebRequestSocket, prematureCloseError } from "./socket.ts";
import type { WebIncomingMessage } from "./incoming.ts";

// Node's OutgoingMessage sets an internal `kNeedDrain` symbol to true when a
// write returns false, and clears it (emitting "drain") from the HTTP server's
// socketOnDrain handler. We don't have access to that symbol publicly, so we
// resolve it from the instance and cache it. The symbol may not be materialized
// on the instance yet at first lookup (it is only set the first time a write is
// backpressured), so a miss must NOT be cached: we keep `undefined` (retry on
// the next call) until the symbol is actually found. Until then we fall back to
// always re-emitting "drain".
let needDrainSymbol: symbol | undefined;
function getNeedDrainSymbol(res: ServerResponse): symbol | undefined {
  needDrainSymbol ??= Object.getOwnPropertySymbols(res).find((s) => s.description === "kNeedDrain");
  return needDrainSymbol;
}

// Statuses that must not carry a response body per the Fetch/HTTP spec.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Connection-level headers describing the synthetic wire this response is
// written to, not the application response itself. Leaking them into the web
// `Response` breaks the next hop: `connection: close` disables keep-alive for
// every bridged response re-served over HTTP/1 and prints an UnsupportedWarning
// per request over HTTP/2, and `transfer-encoding` mislabels a body that is
// never chunk-framed here. https://datatracker.ietf.org/doc/html/rfc9110#section-7.6.1
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

export class WebServerResponse extends ServerResponse {
  #socket: WebRequestSocket;
  #socketError?: Error;

  // Settles once the response head is stored (see the `_storeHeader` patch
  // below), rejects if the socket dies before that.
  #headPromise: Promise<void>;
  #settleHead!: (error?: Error) => void;

  constructor(req: WebIncomingMessage, socket: WebRequestSocket) {
    super(req);
    this.assignSocket(socket);

    this.#headPromise = new Promise<void>((resolve, reject) => {
      this.#settleHead = (error) => (error ? reject(error) : resolve());
    });
    // The head can be rejected with nothing awaiting it yet (e.g. the caller
    // already bailed out on a handler error), which would otherwise take the
    // process down as an unhandled rejection. Awaiters still see the rejection.
    this.#headPromise.catch(() => {});

    // `_storeHeader` is where Node serializes the status line and headers into
    // `_header` — the single funnel for both explicit `writeHead()` and implicit
    // (first `write()`/`end()`) heads. It is patched as an own property rather
    // than overridden on the prototype because Express re-parents the response
    // object, which would drop a prototype override off the chain.
    const storeHeader = (ServerResponse.prototype as any)._storeHeader;
    (this as any)._storeHeader = (firstLine: string, headers: unknown) => {
      storeHeader.call(this, firstLine, headers);

      // A handler setting `transfer-encoding: chunked` explicitly re-enables the
      // chunk framing that `useChunkedEncodingByDefault = false` turned off,
      // which corrupts the captured body (the framing bytes land *inside* it).
      // Nothing here is written to a real wire, so never frame; the header
      // itself is dropped from the web `Response` as hop-by-hop below.
      this.chunkedEncoding = false;

      // The head is complete and frozen from here on (`headersSent` is true), so
      // the web `Response` can be built while the handler is still writing.
      this.#settleHead();
    };

    // `super(req)` enables chunked transfer-encoding by default because the
    // synthetic request now reports HTTP/1.1. But this response isn't written to
    // a real wire: `toWebResponse()` re-wraps the body written to the bridging
    // socket in a web `Response`. Chunk framing would corrupt that body, so keep
    // the output un-chunked (close-delimited).
    this.useChunkedEncodingByDefault = false;

    // Node stamps a `Date` for the synthetic wire; that is the serving hop's job
    // (and it re-stamps one), so don't synthesize it here. A `Date` the handler
    // sets explicitly is still passed through.
    this.sendDate = false;

    this.once("finish", () => {
      socket.end();
    });

    this.#socket = socket;

    // When the client disconnects, the assigned socket is destroyed (e.g. with
    // an AbortError) and emits "error"/"close" without the ServerResponse ever
    // emitting "finish" or "error". Attach this listener synchronously so the
    // socket error is consumed (instead of crashing the process as an unhandled
    // "error" event) and recorded to settle the head waiters on.
    socket.once("error", (err) => {
      this.#socketError ??= err;
      this.#settleHead(err);
    });

    // A socket that dies before the head is stored will never produce one, and
    // the response emits neither "finish" nor "error" — settle the head waiters
    // instead of hanging them. No-op once the head is stored.
    socket.once("close", () => {
      this.#settleHead(this.#socketError ?? prematureCloseError());
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
    this.waitForHead = this.waitForHead.bind(this);
    this.toWebResponse = this.toWebResponse.bind(this);
  }

  /**
   * Resolves as soon as the response head (status + headers) is known — i.e. on
   * `writeHead()` or the first `write()`/`end()` — without waiting for the body,
   * so it can be streamed. Rejects if the socket dies before a head is stored.
   */
  waitForHead(): Promise<void> {
    return this.#headPromise;
  }

  async toWebResponse(): Promise<Response> {
    // Only the head is awaited: the body streams out of the bridging socket as
    // the handler writes it. Waiting for the response to finish would buffer
    // every body in full and never resolve at all for an endless one (SSE).
    await this.#headPromise;

    const headers: [string, string][] = [];

    // this.getHeaders() is unreliable because it misses direct writeHead() calls
    const httpHeader = (this as any)._header?.split("\r\n");
    for (let i = 1; httpHeader && i < httpHeader.length; i++) {
      const sepIndex = httpHeader[i].indexOf(": ");
      if (sepIndex === -1) continue;
      const key = httpHeader[i].slice(0, Math.max(0, sepIndex));
      const value = httpHeader[i].slice(Math.max(0, sepIndex + 2));
      if (!key || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
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
