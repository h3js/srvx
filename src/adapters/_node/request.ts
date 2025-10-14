import type {
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { lazyInherit } from "../../_inherit.ts";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
};

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  let Readable: typeof import("node:stream").Readable;

  const NativeRequest = ((globalThis as any)._Request ??=
    globalThis.Request) as typeof globalThis.Request;

  // Credits to hono/node adapter for global patching idea (https://github.com/honojs/node-server/blob/main/src/request.ts)
  const PatchedRequest = class Request extends NativeRequest {
    static _srvx = true;

    // @ts-expect-error
    static [Symbol.hasInstance](instance) {
      return instance instanceof NativeRequest;
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
    _node!: NodeRequestContext;
    _url!: URL;
    runtime: ServerRequest["runtime"];

    #request?: globalThis.Request;
    #headers?: NodeRequestHeaders;
    #abortSignal?: AbortController;

    constructor(ctx: NodeRequestContext) {
      this._node = ctx;
      this._url = new NodeRequestURL({ req: ctx.req });
      this.runtime = {
        name: "node",
        node: ctx,
      };
    }

    get ip(): string | undefined {
      return this._node.req.socket?.remoteAddress;
    }

    get method(): string {
      return this._node.req.method || "GET";
    }

    get url(): string {
      return this._url.href;
    }

    get headers(): Headers {
      return (this.#headers ||= new NodeRequestHeaders(this._node));
    }

    get signal() {
      if (!this.#abortSignal) {
        this.#abortSignal = new AbortController();
        const req = this._node.req;
        const abort = (err?: any) => {
          this.#abortSignal?.abort(err);
        };
        req.once("error", abort);
        req.once("end", abort);
      }
      return this.#abortSignal.signal;
    }

    get _request(): globalThis.Request {
      if (!this.#request) {
        const method = this.method;
        const hasBody = !(method === "GET" || method === "HEAD");
        if (hasBody && !Readable) {
          Readable =
            globalThis.process.getBuiltinModule("node:stream").Readable;
        }
        this.#request = new PatchedRequest(this.url, {
          method,
          headers: this.headers,
          signal: this.signal,
          body: hasBody
            ? (Readable.toWeb(this._node.req) as unknown as ReadableStream)
            : undefined,
        });
      }

      return this.#request;
    }
  }

  lazyInherit(Request.prototype, NativeRequest.prototype, "_request");

  Object.setPrototypeOf(Request.prototype, NativeRequest.prototype);

  return Request as any;
})();
