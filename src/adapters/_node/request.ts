import type {
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import { NodeRequestURL } from "./url.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { inheritProps } from "./_common.ts";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
};

export const NodeRequest: {
  new (nodeCtx: NodeRequestContext): ServerRequest;
} = /* @__PURE__ */ (() => {
  const { Readable } = process.getBuiltinModule("node:stream");

  const NativeRequest = ((globalThis as any)._Request ??=
    globalThis.Request) as typeof globalThis.Request;

  // Credits to hono/node adapter for global patching idea (https://github.com/honojs/node-server/blob/main/src/request.ts)
  const PatchedRequest = class Request extends NativeRequest {
    static _srvx = true;
    constructor(
      input: string | URL | globalThis.Request,
      options?: RequestInit,
    ) {
      if (typeof input === "object" && "_request" in input) {
        input = (input as unknown as NodeRequest)._request;
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

  class NodeRequest implements Partial<ServerRequest> {
    _node!: NodeRequestContext;
    _url!: URL;
    runtime: ServerRequest["runtime"];

    #request?: Request;
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
        this._node.req.once("close", () => {
          this.#abortSignal?.abort();
        });
      }
      return this.#abortSignal.signal;
    }

    get _request(): Request {
      if (!this.#request) {
        const method = this.method;
        const hasBody = !(method === "GET" || method === "HEAD");
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

  inheritProps(NodeRequest.prototype, NativeRequest.prototype, "_request");

  Object.setPrototypeOf(NodeRequest.prototype, PatchedRequest.prototype);

  return NodeRequest as any;
})();
