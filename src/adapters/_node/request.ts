import type {
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { lazyInherit } from "../../_inherit.ts";
import { Readable } from "node:stream";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
};

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  const NativeRequest = ((globalThis as any)[
    Symbol.for("srvx.nativeRequest")
  ] ??= globalThis.Request) as typeof globalThis.Request;

  // Credits to hono/node adapter for global patching idea (https://github.com/honojs/node-server/blob/main/src/request.ts)
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

    constructor(
      input: string | URL | globalThis.Request,
      options?: RequestInit,
    ) {
      if (typeof input === "object" && "_request" in input) {
        input = (input as any)._request;
      }
      if ((options?.body as ReadableStream)?.getReader !== undefined) {
        (options as any).duplex ??= "half";
      }
      super(input, options);
    }
  };

  // Fix new Request(request) issue with undici constructor by assigning it back to global
  if (!(globalThis.Request as any)._srvx) {
    globalThis.Request = PatchedRequest as unknown as typeof globalThis.Request;
  }

  class Request implements Partial<ServerRequest> {
    runtime: ServerRequest["runtime"];

    #req: NodeServerRequest;
    #res: NodeServerResponse | undefined;
    #url?: URL;
    #bodyStream?: ReadableStream | null;
    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortController?: AbortController;

    constructor(ctx: NodeRequestContext) {
      this.#req = ctx.req;
      this.#res = ctx.res;
      this.runtime = {
        name: "node",
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
        const req = this.#req;
        const res = this.#res;
        const abortController = this.#abortController;

        const abort = (err?: any) => {
          abortController?.abort?.(err);
        };

        req.once("error", abort);

        if (res) {
          // Primary path: detect client disconnect via response close
          res.on("close", () => {
            if (req.errored) {
              abort(req.errored);
            } else if (!res.writableEnded) {
              abort();
            }
          });
        } else {
          // Fallback for request-only contexts (no response object)
          req.once("close", () => {
            if (!req.complete) {
              // Request body wasn't fully received - client disconnected
              abort();
            }
          });
        }
      }
      return this.#abortController;
    }

    get signal() {
      return this.#request
        ? this.#request.signal
        : this._abortController.signal;
    }

    get body(): ReadableStream | null {
      if (this.#request) {
        return this.#request.body;
      }
      if (this.#bodyStream === undefined) {
        const method = this.method;
        const hasBody = !(method === "GET" || method === "HEAD");
        this.#bodyStream = hasBody
          ? (Readable.toWeb(this.#req) as unknown as ReadableStream)
          : null;
      }
      return this.#bodyStream;
    }

    text() {
      if (this.#request) {
        return this.#request.text();
      }
      if (this.#bodyStream !== undefined) {
        return this.#bodyStream
          ? new Response(this.#bodyStream).text()
          : Promise.resolve("");
      }
      return readBody(this.#req).then((buf) => buf.toString());
    }

    json() {
      if (this.#request) {
        return this.#request.json();
      }
      return this.text().then((text) => JSON.parse(text));
    }

    get _request(): globalThis.Request {
      if (!this.#request) {
        this.#request = new PatchedRequest(this.url, {
          method: this.method,
          headers: this.headers,
          body: this.body,
          signal: this._abortController.signal,
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

function readBody(req: NodeServerRequest): Promise<any> {
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
      resolve(Buffer.concat(chunks));
    };
    req.on("data", onData).once("end", onEnd).once("error", onError);
  });
}
