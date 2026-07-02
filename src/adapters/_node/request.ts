import type { NodeServerRequest, NodeServerResponse, ServerRequest } from "../../types.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { lazyInherit } from "../../_inherit.ts";
import { Readable } from "node:stream";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
  /**
   * Maximum allowed size (in bytes) for the request body, enforced for both the
   * buffered reads and the streamed body. See `ServerOptions.maxBodySize`.
   */
  maxBodySize?: number;
};

const kNativeRequest = /* @__PURE__ */ Symbol.for("srvx.nativeRequest");

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  const NativeRequest = getNativeRequest();

  class Request implements Partial<ServerRequest> {
    runtime: ServerRequest["runtime"];

    #req: NodeServerRequest;
    #url?: URL;
    #bodyStream?: ReadableStream | null;
    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortController?: AbortController;
    #maxBodySize?: number;

    constructor(ctx: NodeRequestContext) {
      this.#req = ctx.req;
      this.#maxBodySize = ctx.maxBodySize;
      this.runtime = {
        name: "node",
        // Reuse the context object as-is to avoid a per-request allocation on
        // the hot path. `maxBodySize` may ride along but is intentionally not
        // part of the public `runtime.node` type; consumers only read req/res.
        node: ctx,
      };
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeRequest;
    }

    get ip(): string | undefined {
      return this.#req.socket?.remoteAddress;
    }

    get method(): string {
      if (this.#request) {
        return this.#request.method;
      }
      return this.#req.method || "GET";
    }

    get _url() {
      return (this.#url ||= new NodeRequestURL({ req: this.#req }));
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

    get body(): ReadableStream | null {
      if (this.#request) {
        return this.#request.body;
      }
      if (this.#bodyStream === undefined) {
        const method = this.method;
        const hasBody = !(method === "GET" || method === "HEAD");
        let stream = hasBody
          ? // TODO: HTTP2ServerRequest
            (Readable.toWeb(this.#req as NodeJS.ReadableStream) as unknown as ReadableStream)
          : null;
        // Enforce `maxBodySize` at the single choke point every consumer funnels
        // through (`request.body`, and therefore the native `Request` methods
        // `arrayBuffer()` / `blob()` / `bytes()` / `formData()` and streaming).
        if (stream && this.#maxBodySize !== undefined) {
          stream = limitBodyStream(stream, this.#maxBodySize);
        }
        this.#bodyStream = stream;
      }
      return this.#bodyStream;
    }

    text() {
      if (this.#request) {
        return this.#request.text();
      }
      if (this.#bodyStream !== undefined) {
        return this.#bodyStream ? new Response(this.#bodyStream).text() : Promise.resolve("");
      }
      return readBody(this.#req, this.#maxBodySize).then((buf) => buf.toString());
    }

    json() {
      if (this.#request) {
        return this.#request.json();
      }
      return this.text().then((text) => JSON.parse(text));
    }

    get _request(): globalThis.Request {
      if (!this.#request) {
        const body = this.body;
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
 * not consumed as a stream. When `maxBodySize` (bytes) is provided, the accumulated
 * length is tracked as chunks arrive and, once it is exceeded, reading is aborted
 * (the stream is paused so a handler can still send a response) and the promise
 * rejects with a `413`-style error. When `maxBodySize` is `undefined` (the default)
 * no limit is enforced.
 */
function readBody(req: NodeServerRequest, maxBodySize?: number): Promise<any> {
  // https://github.com/GoogleCloudPlatform/functions-framework-nodejs/blob/5ce5e513d739fdb8388fb0e8b6fd5f52d59604f2/src/server.ts#L62
  if ("rawBody" in req && Buffer.isBuffer(req.rawBody)) {
    if (maxBodySize !== undefined && req.rawBody.length > maxBodySize) {
      return Promise.reject(createBodyTooLargeError(maxBodySize));
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
      if (maxBodySize !== undefined) {
        size += chunk.length;
        if (size > maxBodySize) {
          cleanup();
          // Stop consuming the body but keep the socket alive so a handler can
          // still respond (e.g. with an HTTP 413).
          req.pause?.();
          reject(createBodyTooLargeError(maxBodySize));
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
      resolve(Buffer.concat(chunks));
    };
    req.on("data", onData).once("end", onEnd).once("error", onError);
  });
}

/**
 * Wraps a body `ReadableStream` so the total number of bytes read cannot exceed
 * `maxBodySize`. Once the limit is passed the wrapped stream errors with a
 * `413`-style error and the upstream (Node request) stream is cancelled. This
 * is pull-based, so it preserves backpressure and stops reading as soon as the
 * limit is hit rather than buffering the whole body first.
 */
function limitBodyStream(stream: ReadableStream, maxBodySize: number): ReadableStream {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      size += (value as Uint8Array).byteLength;
      if (size > maxBodySize) {
        const error = createBodyTooLargeError(maxBodySize);
        reader.cancel(error).catch(() => {});
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Creates a `413 Payload Too Large` style error for when a request body exceeds
 * the configured `maxBodySize`. The `statusCode` / `status` properties let a
 * handler map it to an HTTP 413 response.
 */
function createBodyTooLargeError(maxBodySize: number): Error {
  return Object.assign(
    new Error(`Request body exceeds the maximum allowed size of ${maxBodySize} bytes.`),
    { code: "ERR_BODY_TOO_LARGE", statusCode: 413, status: 413 },
  );
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
