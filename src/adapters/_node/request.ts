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
  const NativeRequest = globalThis.Request;

  const { Readable } = process.getBuiltinModule("node:stream");

  if (!("_srvx" in NativeRequest)) {
    // Credits to hono/node adapter for global patching idea
    // https://github.com/honojs/node-server/blob/main/src/request.ts
    class Request extends NativeRequest {
      static _srvx = true;
      constructor(input: string | URL | Request, options?: RequestInit) {
        if (typeof input === "object" && "_request" in input) {
          input = (input as any)._request;
        }
        if ((options?.body as ReadableStream)?.getReader !== undefined) {
          (options as any).duplex ??= "half";
        }
        super(input, options);
      }
    }
    // Fix new Request(request) issue with undici constructor by assigning it back to global
    globalThis.Request = Request as unknown as typeof globalThis.Request;
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
        this.#request = new Request(this.url, {
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

  Object.setPrototypeOf(NodeRequest.prototype, Request.prototype);

  return NodeRequest as any;
})();

export type NodeRequest = InstanceType<typeof NodeRequest>;
