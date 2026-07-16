import type { NodeServerRequest, NodeServerResponse, ServerRequest } from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { isTrustedProxy, firstForwardedValue } from "../../_trust-proxy.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { lazyInherit } from "../../_inherit.ts";
import { createBodyTooLargeError, limitBodyStream } from "../../_body-limit.ts";
import { Readable } from "node:stream";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
  /**
   * Maximum allowed size (in bytes) for the request body, enforced for both the
   * buffered reads and the streamed body. See `ServerOptions.maxRequestBodySize`.
   */
  maxRequestBodySize?: number;
  /**
   * Whether to trust `X-Forwarded-*` / `:scheme` headers when deriving the
   * request protocol, host and client IP. See `ServerOptions.trustProxy`.
   */
  trustProxy?: TrustProxyOption;
};

const kNativeRequest = /* @__PURE__ */ Symbol.for("srvx.nativeRequest");

/** Rejection for a second read of an already-consumed body (matches native fetch). */
function bodyUnusable(): TypeError {
  return new TypeError("Body is unusable: Body has already been read");
}

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  const NativeRequest = getNativeRequest();

  class Request implements Partial<ServerRequest> {
    runtime: ServerRequest["runtime"];
    // Declared so the post-construction `request.waitUntil = ...` assignment
    // in the adapters doesn't add a property (hidden-class transition) per
    // request.
    waitUntil?: ServerRequest["waitUntil"];

    #req: NodeServerRequest;
    #url?: URL;
    #bodyStream?: ReadableStream | null;
    // Tracks body consumption at the srvx level so a second read rejects with
    // `TypeError: Body is unusable` (like native fetch) instead of hanging on a
    // re-listened, already-ended IncomingMessage, and so `bodyUsed` can be
    // served without materializing a native Request over a disturbed stream.
    #bodyUsed = false;
    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortController?: AbortController;
    #maxRequestBodySize?: number;
    #trustProxy?: TrustProxyOption;
    #ip?: string;
    #ipResolved = false;
    #remoteAddress?: string;
    #trusted?: boolean;

    constructor(ctx: NodeRequestContext) {
      this.#req = ctx.req;
      this.#maxRequestBodySize = ctx.maxRequestBodySize;
      this.#trustProxy = ctx.trustProxy;
      this.runtime = {
        name: "node",
        // Reuse the context object as-is to avoid a per-request allocation on
        // the hot path. `maxRequestBodySize` may ride along but is intentionally not
        // part of the public `runtime.node` type; consumers only read req/res.
        node: ctx,
      };
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeRequest;
    }

    // Resolve the trust decision once: the peer address is fixed for the
    // lifetime of the request, and both `ip` and `_url` need it. `isTrustedProxy`
    // (and the `socket.remoteAddress` read) would otherwise run twice per request.
    #resolveTrusted(): boolean {
      if (this.#trusted === undefined) {
        this.#remoteAddress = this.#req.socket?.remoteAddress;
        this.#trusted = isTrustedProxy(this.#trustProxy, this.#remoteAddress);
      }
      return this.#trusted;
    }

    get ip(): string | undefined {
      // Resolve once: the peer address and forwarded header are fixed for the
      // lifetime of the request.
      if (this.#ipResolved) {
        return this.#ip;
      }
      this.#ipResolved = true;
      const trusted = this.#resolveTrusted();
      // Only honor `X-Forwarded-For` when the immediate peer is a trusted proxy;
      // otherwise any client could forge its address. The leftmost entry is the
      // original client as seen by the outermost trusted proxy.
      if (trusted) {
        const forwarded = firstForwardedValue(this.#req.headers["x-forwarded-for"]);
        if (forwarded) {
          return (this.#ip = forwarded);
        }
      }
      return (this.#ip = this.#remoteAddress);
    }

    get method(): string {
      if (this.#request) {
        return this.#request.method;
      }
      return this.#req.method || "GET";
    }

    get _url() {
      return (this.#url ||= new NodeRequestURL({
        req: this.#req,
        trusted: this.#resolveTrusted(),
      }));
    }

    set _url(url: URL) {
      this.#url = url;
    }

    get url(): string {
      if (this.#request) {
        return this.#request.url;
      }
      return this._url.href;
    }

    get headers(): Headers {
      // Return the srvx-side Headers object whenever it exists, even after the
      // native Request has materialized. Materializing `_request` always reads
      // `this.headers` (so `#headers` is populated) but the native constructor
      // copies the entries into its own Headers instance. Switching the getter
      // to `this.#request.headers` there would leave a reference taken earlier
      // (`const h = req.headers; req._request; h.set(...)`) pointing at a now-
      // detached object whose mutations are invisible. Keeping `#headers`
      // canonical keeps those references live.
      if (this.#headers) {
        return this.#headers;
      }
      if (this.#request) {
        // Unreachable in practice: materializing `_request` reads `this.headers`
        // first, so `#headers` is always set. Kept as defense in depth.
        return this.#request.headers;
      }
      return (this.#headers = new NodeRequestHeaders(this.#req));
    }

    get _abortController() {
      if (!this.#abortController) {
        this.#abortController = new AbortController();
        const { req, res } = this.runtime!.node!;
        const abortController = this.#abortController;
        const abort = (err?: Error) => abortController.abort?.(err);
        if (res) {
          res.once("close", () => {
            const reqError = req.errored;
            if (reqError) {
              abort(reqError); // request error
            } else if (!res.writableEnded) {
              abort(); // server closed before finishing response
            }
          });
        } else {
          req.once("close", () => {
            if (!req.complete) {
              abort(); // client disconnected
            }
          });
        }
      }
      return this.#abortController;
    }

    get signal() {
      return this.#request ? this.#request.signal : this._abortController.signal;
    }

    // Per the fetch spec, GET/HEAD requests always have a null body regardless of
    // what was on the wire. Raw bytes remain reachable via `runtime.node.req`.
    #hasBody(): boolean {
      const method = this.method;
      return method !== "GET" && method !== "HEAD";
    }

    get body(): ReadableStream | null {
      if (this.#request) {
        return this.#request.body;
      }
      if (this.#bodyStream === undefined) {
        // No stream for a null-body (GET/HEAD) request, and never re-wrap an
        // already-consumed IncomingMessage (the fast path leaves it ended, so a
        // fresh `Readable.toWeb` would produce a stream whose `end` never fires).
        let stream =
          this.#hasBody() && !this.#bodyUsed
            ? // TODO: HTTP2ServerRequest
              (Readable.toWeb(this.#req as NodeJS.ReadableStream) as unknown as ReadableStream)
            : null;
        // Enforce `maxRequestBodySize` at the single choke point every consumer funnels
        // through (`request.body`, and therefore the native `Request` methods
        // `arrayBuffer()` / `blob()` / `bytes()` / `formData()` and streaming).
        if (stream && this.#maxRequestBodySize !== undefined) {
          stream = limitBodyStream(stream, this.#maxRequestBodySize);
        }
        this.#bodyStream = stream;
      }
      return this.#bodyStream;
    }

    get bodyUsed(): boolean {
      // Serve from srvx state: after a fast-path read the native Request is never
      // materialized (or is materialized with a null body), so it would otherwise
      // report `false` or throw when the underlying stream is disturbed.
      if (this.#bodyUsed) {
        return true;
      }
      return this.#request ? this.#request.bodyUsed : false;
    }

    // Buffer the raw request body once; consumers add their own single
    // continuation (`.toString()` / `JSON.parse`) so no extra promise or
    // microtask hop is introduced vs. inlining the read.
    #readBuffered() {
      return readBody(this.#req, this.#maxRequestBodySize);
    }

    text(): Promise<string> {
      // A second read of an already-consumed body must reject like native fetch
      // rather than re-listen to an ended stream (which would hang).
      if (this.#bodyUsed) {
        return Promise.reject(bodyUnusable());
      }
      if (this.#request) {
        return this.#request.text();
      }
      // GET/HEAD: null body, so `text()` is repeatable and resolves to "".
      if (!this.#hasBody()) {
        return Promise.resolve("");
      }
      this.#bodyUsed = true;
      if (this.#bodyStream !== undefined) {
        // `new Response(stream)` throws *synchronously* if the stream is already
        // locked/disturbed (e.g. a consumer took `req.body` and read it
        // directly). Surface that as a rejected promise, matching native fetch.
        try {
          return new Response(this.#bodyStream).text();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return this.#readBuffered().then((buf) => buf.toString());
    }

    json(): Promise<any> {
      if (this.#bodyUsed) {
        return Promise.reject(bodyUnusable());
      }
      if (this.#request) {
        return this.#request.json();
      }
      // GET/HEAD: null body — match a null-body native Request (`JSON.parse("")`).
      if (!this.#hasBody()) {
        return Promise.resolve().then(() => JSON.parse(""));
      }
      this.#bodyUsed = true;
      if (this.#bodyStream !== undefined) {
        // See text(): a locked/disturbed stream must reject, not throw.
        try {
          return new Response(this.#bodyStream).json();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      // Parse in a single continuation (readBody -> parse) instead of going
      // through text() — one less promise + microtask hop per body read.
      return this.#readBuffered().then((buf) => JSON.parse(buf.toString()));
    }

    get _request(): globalThis.Request {
      if (!this.#request) {
        // If the body was already consumed via the buffered/stream fast path the
        // underlying IncomingMessage is disturbed; wrapping it in a native
        // Request throws synchronously ("Response body object should not be
        // disturbed or locked") and poisons `bodyUsed` / `clone()` / `formData()`
        // / `blob()` / `mode` / `referrer`. Serve a null-body Request instead and
        // let `bodyUsed` reflect srvx state.
        const body = this.#bodyUsed ? null : this.body;
        this.#request = new NativeRequest(this.url, {
          method: this.method,
          headers: this.headers,
          signal: this._abortController.signal,
          body,
          // @ts-expect-error Undici specific
          duplex: body ? "half" : undefined,
        });
        // Keep `#headers` so `get headers()` returns the same object identity
        // before and after materialization (see the note there). The native
        // Request holds its own snapshot copy: mutations made after this point
        // show up in `req.headers` but not in `#request.headers` — and thus not
        // in `clone()` or `formData()`, which delegate to the native Request.
        this.#bodyStream = undefined;
      }

      return this.#request;
    }
  }

  lazyInherit(Request.prototype, NativeRequest.prototype, "_request");

  Object.setPrototypeOf(Request.prototype, NativeRequest.prototype);

  return Request as any;
})();

/**
 * Undici uses an incompatible Request constructor depending on private property accessors.
 *
 * This utility, patches global Request to support `new Request(req)` in Node.js.
 *
 * Alternatively you can use `new Request(req._request || req)` instead of patching global Request.
 */
export function patchGlobalRequest(): typeof Request {
  const NativeRequest = getNativeRequest();

  const PatchedRequest = class Request extends NativeRequest {
    static _srvx = true;
    // @ts-expect-error
    static [Symbol.hasInstance](instance) {
      if (this === PatchedRequest) {
        return instance instanceof NativeRequest;
      } else {
        return Object.prototype.isPrototypeOf.call(this.prototype, instance);
      }
    }
    constructor(input: string | URL | globalThis.Request, options?: RequestInit) {
      if (typeof input === "object" && "_request" in input) {
        input = (input as any)._request;
      }
      super(input, options);
    }
  };
  if (!(globalThis.Request as any)._srvx) {
    globalThis.Request = PatchedRequest as unknown as typeof globalThis.Request;
  }
  return PatchedRequest;
}

/**
 * Buffers the whole request body into a single `Buffer`.
 *
 * This is the fallback used by `NodeRequest.text()` / `.json()` when the body was
 * not consumed as a stream. When `maxRequestBodySize` (bytes) is provided, the accumulated
 * length is tracked as chunks arrive and, once it is exceeded, reading is aborted
 * (the stream is paused so a handler can still send a response) and the promise
 * rejects with a `413`-style error. When `maxRequestBodySize` is `undefined` (the default)
 * no limit is enforced.
 */
function readBody(req: NodeServerRequest, maxRequestBodySize?: number): Promise<any> {
  // https://github.com/GoogleCloudPlatform/functions-framework-nodejs/blob/5ce5e513d739fdb8388fb0e8b6fd5f52d59604f2/src/server.ts#L62
  if ("rawBody" in req && Buffer.isBuffer(req.rawBody)) {
    if (maxRequestBodySize !== undefined && req.rawBody.length > maxRequestBodySize) {
      return Promise.reject(createBodyTooLargeError(maxRequestBodySize));
    }
    return Promise.resolve(req.rawBody);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: any) => {
      if (maxRequestBodySize !== undefined) {
        size += chunk.length;
        if (size > maxRequestBodySize) {
          cleanup();
          // Stop consuming the body but keep the socket alive so a handler can
          // still respond (e.g. with an HTTP 413).
          req.pause?.();
          reject(createBodyTooLargeError(maxRequestBodySize));
          return;
        }
      }
      chunks.push(chunk);
    };
    const onError = (err: any) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      // Single-chunk bodies (the common case) skip Buffer.concat's alloc+copy
      resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    };
    req.on("data", onData).once("end", onEnd).once("error", onError);
  });
}

/**
 * Resolve the genuine native `Request` and cache it globally.
 *
 * `patchGlobalRequest()` replaces `globalThis.Request` with a srvx subclass
 * (its prototype has no own body methods). If that patched global is captured
 * as the "native" Request — e.g. when a second srvx instance evaluates after
 * the global was patched, as happens in a bundled build — then `lazyInherit`
 * copies no body methods and `formData()`/`blob()`/`arrayBuffer()`/`bytes()`
 * fall through to undici with the wrong receiver and throw. Reading the shared
 * cache (and unwrapping any srvx-patched subclass) keeps us on the real native
 * Request regardless of patch ordering.
 */
function getNativeRequest(): typeof globalThis.Request {
  let R: any = (globalThis as any)[kNativeRequest] || globalThis.Request;
  while (R?._srvx) {
    R = Object.getPrototypeOf(R);
  }
  return ((globalThis as any)[kNativeRequest] ??= R);
}
