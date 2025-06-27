import { kNodeInspect } from "./_common.ts";
import { NodeRequestHeaders } from "./headers.ts";
import { NodeRequestURL } from "./url.ts";

import type {
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
  ServerRuntimeContext,
} from "../../types.ts";

export type NodeRequestContext = {
  req: NodeServerRequest;
  res?: NodeServerResponse;
};

export const NodeRequest = /* @__PURE__ */ (() => {
  const unsupportedGetters = [
    "cache",
    "credentials",
    "destination",
    "integrity",
    "keepalive",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
  ] as const;

  const _Request = class Request
    implements Omit<ServerRequest, (typeof unsupportedGetters)[number]>
  {
    #url?: InstanceType<typeof NodeRequestURL>;
    #headers?: InstanceType<typeof NodeRequestHeaders>;
    #bodyUsed: boolean = false;
    #abortSignal?: AbortController;
    #hasBody: boolean | undefined;
    #bodyBytes?: Promise<Uint8Array<ArrayBuffer>>;
    #blobBody?: Promise<Blob>;
    #formDataBody?: Promise<FormData>;
    #jsonBody?: Promise<any>;
    #textBody?: Promise<string>;
    #bodyStream?: undefined | ReadableStream<Uint8Array>;

    _node: { req: NodeServerRequest; res?: NodeServerResponse };
    runtime: ServerRuntimeContext;

    constructor(nodeCtx: NodeRequestContext) {
      this._node = nodeCtx;
      this.runtime = {
        name: "node",
        node: nodeCtx,
      };
    }

    get ip() {
      return this._node.req.socket?.remoteAddress;
    }

    get headers() {
      if (!this.#headers) {
        this.#headers = new NodeRequestHeaders(this._node);
      }
      return this.#headers;
    }

    clone(): ServerRequest {
      return new _Request({ ...this._node }) as unknown as ServerRequest;
    }

    get _url() {
      if (!this.#url) {
        this.#url = new NodeRequestURL(this._node);
      }
      return this.#url;
    }

    get url() {
      return this._url.href;
    }

    get method() {
      return this._node.req.method || "GET";
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

    get bodyUsed() {
      return this.#bodyUsed;
    }

    get _hasBody() {
      if (this.#hasBody !== undefined) {
        return this.#hasBody;
      }
      // Check if request method requires a payload
      const method = this._node.req.method?.toUpperCase();
      if (
        !method ||
        !(
          method === "PATCH" ||
          method === "POST" ||
          method === "PUT" ||
          method === "DELETE"
        )
      ) {
        this.#hasBody = false;
        return false;
      }

      // Make sure either content-length or transfer-encoding/chunked is set
      if (!Number.parseInt(this._node.req.headers["content-length"] || "")) {
        const isChunked = (this._node.req.headers["transfer-encoding"] || "")
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
          .includes("chunked");
        if (!isChunked) {
          this.#hasBody = false;
          return false;
        }
      }
      this.#hasBody = true;
      return true;
    }

    get body() {
      if (!this._hasBody) {
        return null;
      }
      if (!this.#bodyStream) {
        this.#bodyUsed = true;
        this.#bodyStream = new ReadableStream({
          start: (controller) => {
            this._node.req
              .on("data", (chunk) => {
                controller.enqueue(chunk);
              })
              .once("error", (error) => {
                controller.error(error);
                this.#abortSignal?.abort();
              })
              .once("close", () => {
                this.#abortSignal?.abort();
              })
              .once("end", () => {
                controller.close();
              });
          },
        });
      }
      return this.#bodyStream;
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
      if (!this.#bodyBytes) {
        const _bodyStream = this.body;
        this.#bodyBytes = _bodyStream
          ? _readStream(_bodyStream)
          : Promise.resolve(new Uint8Array());
      }
      return this.#bodyBytes;
    }

    arrayBuffer(): Promise<ArrayBuffer> {
      return this.bytes().then((buff) => {
        return buff.buffer.slice(
          buff.byteOffset,
          buff.byteOffset + buff.byteLength,
        ) as ArrayBuffer;
      });
    }

    blob(): Promise<Blob> {
      if (!this.#blobBody) {
        this.#blobBody = this.bytes().then((bytes) => {
          return new Blob([bytes], {
            type: this._node.req.headers["content-type"],
          });
        });
      }
      return this.#blobBody;
    }

    formData(): Promise<FormData> {
      if (!this.#formDataBody) {
        this.#formDataBody = new Response(this.body, {
          headers: this.headers as unknown as Headers,
        }).formData();
      }
      return this.#formDataBody;
    }

    text(): Promise<string> {
      if (!this.#textBody) {
        this.#textBody = this.bytes().then((bytes) => {
          return new TextDecoder().decode(bytes);
        });
      }
      return this.#textBody;
    }

    json(): Promise<any> {
      if (!this.#jsonBody) {
        this.#jsonBody = this.text().then((txt) => {
          return JSON.parse(txt);
        });
      }
      return this.#jsonBody;
    }

    get [Symbol.toStringTag]() {
      return "Request";
    }

    [kNodeInspect]() {
      return {
        method: this.method,
        url: this.url,
        headers: this.headers,
      };
    }
  };

  for (const key of unsupportedGetters) {
    Object.defineProperty(_Request.prototype, key, {
      enumerable: true,
      configurable: false,
    });
  }

  Object.setPrototypeOf(_Request.prototype, globalThis.Request.prototype);

  return _Request;
})() as unknown as {
  new (nodeCtx: NodeRequestContext): ServerRequest;
};

async function _readStream(stream: ReadableStream) {
  const chunks: Uint8Array[] = [];
  await stream.pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
  );
  return Buffer.concat(chunks);
}
