import type { NodeServerRequest, NodeServerResponse, ServerRequest } from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { resolveClientIP, trustedHops } from "../../_trust-proxy.ts";
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
    // The fetch spec's "disturbed" bit, tracked at the srvx level: set by the
    // buffered fast path (text()/json()) and by the first read/cancel of the
    // stream `body` hands out. Every body read rejects with `TypeError: Body is
    // unusable` once set (like native fetch) instead of hanging on a re-listened,
    // already-ended IncomingMessage or resolving empty off the null-body Request
    // that `_request` serves in this state. Also lets `bodyUsed` answer without
    // materializing a native Request over a disturbed stream.
    #bodyUsed = false;
    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortController?: AbortController;
    #maxRequestBodySize?: number;
    #trustProxy?: TrustProxyOption;
    #ip?: string;
    #ipResolved = false;
    #remoteAddress?: string;
    #remoteResolved = false;
    #hops?: number;

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

    // Read the socket peer address once: it is the nearest hop, fixed for the
    // lifetime of the request, and both `ip` and `_url` need it (the trust
    // decision and hop walk key off it).
    #remoteAddr(): string | undefined {
      if (!this.#remoteResolved) {
        this.#remoteResolved = true;
        this.#remoteAddress = this.#req.socket?.remoteAddress;
      }
      return this.#remoteAddress;
    }

    // Resolve the trusted hop count once: it gates `X-Forwarded-Proto`/`-Host`
    // (in `NodeRequestURL`) and mirrors the client-IP walk here.
    #resolveHops(): number {
      if (this.#hops === undefined) {
        this.#hops = trustedHops(
          this.#trustProxy,
          this.#remoteAddr(),
          this.#req.headers["x-forwarded-for"],
        );
      }
      return this.#hops;
    }

    get ip(): string | undefined {
      // Resolve once: the peer address and forwarded header are fixed for the
      // lifetime of the request.
      if (this.#ipResolved) {
        return this.#ip;
      }
      this.#ipResolved = true;
      // Hop-aware: the client is the first `X-Forwarded-For` address (walking
      // right-to-left from the peer) that is not a trusted proxy. Untrusted peer
      // -> the header is ignored and the peer is the client.
      return (this.#ip = resolveClientIP(
        this.#trustProxy,
        this.#remoteAddr(),
        this.#req.headers["x-forwarded-for"],
      ));
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
        hops: this.#resolveHops(),
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
      if (this.#request) {
        return this.#request.headers;
      }
      return (this.#headers ||= new NodeRequestHeaders(this.#req));
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
        if (stream) {
          // Enforce `maxRequestBodySize` at the single choke point every consumer funnels
          // through (`request.body`, and therefore the native `Request` methods
          // `arrayBuffer()` / `blob()` / `bytes()` / `formData()` and streaming).
          if (this.#maxRequestBodySize !== undefined) {
            stream = limitBodyStream(stream, this.#maxRequestBodySize);
          }
          stream = trackDisturbed(stream, () => {
            // Only while srvx still owns the body. Once `_request` holds it, undici
            // owns the accounting and reports it per-Request: `clone()` tees this
            // stream, so a pull here may be the *clone* being read, which must not
            // mark this request's body used.
            if (!this.#request) {
              this.#bodyUsed = true;
            }
          });
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

    arrayBuffer(): Promise<ArrayBuffer> {
      return this.#consumeNative("arrayBuffer");
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
      return this.#consumeNative("bytes");
    }

    blob(): Promise<Blob> {
      return this.#consumeNative("blob");
    }

    formData(): Promise<FormData> {
      return this.#consumeNative("formData");
    }

    // Unlike text()/json() these have no buffered fast path — they hand off to the
    // native Request, which owns the accounting from there. The one case it cannot
    // see is a body srvx already consumed: `_request` then serves a *null-body*
    // Request (see `_request`), whose body is pristine, so undici's own
    // "Body is unusable" guard never fires and the read resolves empty. Guard here.
    #consumeNative(method: "arrayBuffer" | "bytes" | "blob" | "formData"): Promise<any> {
      if (this.#bodyUsed) {
        return Promise.reject(bodyUnusable());
      }
      try {
        return this._request[method]();
      } catch (error) {
        // Materializing `_request` throws synchronously if the body stream is
        // locked (a consumer holds a reader). Reject like native fetch.
        return Promise.reject(error);
      }
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
        this.#headers = undefined;
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
 * Wraps a body stream so `onDisturb` fires the first time it is read or cancelled.
 *
 * `request.body` is handed straight to the consumer, so reading it bypasses the
 * `#bodyUsed` flag that `text()` / `json()` set. A `ReadableStream` doesn't expose
 * the fetch spec's "disturbed" bit, so observing it means wrapping.
 *
 * `highWaterMark: 0` is what keeps this honest: with the default of 1 the stream
 * would pull a chunk as soon as it is constructed, marking a body as used merely
 * because a handler touched `request.body`.
 */
function trackDisturbed(stream: ReadableStream, onDisturb: () => void): ReadableStream {
  const reader = stream.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        onDisturb();
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        onDisturb();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Undici uses an incompatible Request constructor depending on private property accessors.
 *
 * This utility, patches global Request to support `new Request(req)` in Node.js.
 *
 * Alternatively you can use `new Request(req._request || req)` instead of patching global Request.
 */
export function patchGlobalRequest(): typeof Request {
  // Idempotent: if the global is already patched, return the installed class
  // so `patchGlobalRequest() === globalThis.Request` holds on repeated calls.
  if ((globalThis.Request as any)._srvx) {
    return globalThis.Request as unknown as typeof Request;
  }

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
  globalThis.Request = PatchedRequest as unknown as typeof globalThis.Request;
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
