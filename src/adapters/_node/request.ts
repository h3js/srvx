import type { NodeServerRequest, NodeServerResponse, ServerRequest } from "../../types.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { lazyInherit } from "../../_inherit.ts";
import { Readable } from "node:stream";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
};

// Pre-allocated runtime descriptor — avoids per-request object creation
const NODE_RUNTIME_NAME = "node" as const;

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  const NativeRequest = globalThis.Request;

  class Request implements Partial<ServerRequest> {
    runtime: ServerRequest["runtime"];

    #req: NodeServerRequest;
    #urlHref?: string;
    #url?: URL;
    #bodyStream?: ReadableStream | null;
    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortController?: AbortController;

    constructor(ctx: NodeRequestContext) {
      this.#req = ctx.req;
      this.runtime = {
        name: NODE_RUNTIME_NAME,
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
      this.#urlHref = undefined;
    }

    get url(): string {
      if (this.#request) {
        return this.#request.url;
      }
      // Cache the href string — avoids repeated FastURL.href getter chain
      return (this.#urlHref ??= this._url.href);
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
        this.#bodyStream = hasBody
          ? // TODO: HTTP2ServerRequest
            (Readable.toWeb(this.#req as NodeJS.ReadableStream) as unknown as ReadableStream)
          : null;
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
      return readBody(this.#req).then(bufToString);
    }

    json() {
      if (this.#request) {
        return this.#request.json();
      }
      // Fast path: read body buffer directly, parse in one step
      // Saves one Promise chain link vs text().then(JSON.parse)
      if (this.#bodyStream !== undefined) {
        return this.#bodyStream
          ? new Response(this.#bodyStream).json()
          : Promise.resolve(undefined);
      }
      return readBody(this.#req).then(bufToJSON);
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
  const NativeRequest = ((globalThis as any)[Symbol.for("srvx.nativeRequest")] ??=
    globalThis.Request) as typeof globalThis.Request;

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

// Shared helpers — avoid per-request closure allocation
function bufToString(buf: Buffer): string {
  return buf.toString();
}

function bufToJSON(buf: Buffer): unknown {
  return JSON.parse(buf.toString());
}

function readBody(req: NodeServerRequest): Promise<Buffer> {
  // https://github.com/GoogleCloudPlatform/functions-framework-nodejs/blob/5ce5e513d739fdb8388fb0e8b6fd5f52d59604f2/src/server.ts#L62
  if ("rawBody" in req && Buffer.isBuffer(req.rawBody)) {
    return Promise.resolve(req.rawBody);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: any) => {
      chunks.push(chunk);
    };
    const onError = (err: any) => {
      reject(err);
    };
    const onEnd = () => {
      req.off("error", onError);
      req.off("data", onData);
      // Single-chunk fast path: avoid Buffer.concat overhead for small payloads
      resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    };
    req.on("data", onData).once("end", onEnd).once("error", onError);
  });
}
