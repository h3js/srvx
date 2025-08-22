import { kNodeInspect } from "../_node/_common.ts";
import { UWSRequestHeaders } from "./headers.ts";

import type {
  UWSServerRequest,
  UWSServerResponse,
  ServerRequest,
  ServerRuntimeContext,
} from "../../types.ts";

export type UWSRequestContext = {
  req: UWSServerRequest;
  res: UWSServerResponse;
};

export const UWSRequest = /* @__PURE__ */ (() => {
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
    #headers?: InstanceType<typeof UWSRequestHeaders>;
    #bodyUsed: boolean = false;
    #abortSignal?: AbortController;
    #bodyBytes?: Promise<Uint8Array<ArrayBuffer>>;
    #blobBody?: Promise<Blob>;
    #formDataBody?: Promise<FormData>;
    #jsonBody?: Promise<unknown>;
    #textBody?: Promise<string>;
    #bodyStream?: undefined | ReadableStream<Uint8Array<ArrayBuffer>>;

    _uws: UWSRequestContext;
    runtime: ServerRuntimeContext;

    constructor(uwsCtx: UWSRequestContext) {
      this._uws = uwsCtx;
      this.runtime = {
        name: "uws",
        uws: uwsCtx,
      };
      this._uws.res.onAborted(() => {
        this.#abortSignal?.abort();
      });
    }

    get ip() {
      return new TextDecoder().decode(this._uws.res.getRemoteAddressAsText());
    }

    get headers() {
      if (!this.#headers) {
        this.#headers = new UWSRequestHeaders(this._uws.req);
      }
      return this.#headers;
    }

    clone: any = () => {
      return new _Request({ ...this._uws }) as unknown as ServerRequest;
    };

    get url() {
      const query = this._uws.req.getQuery();
      return (
        (this._uws.req.getHeader("x-forwarded-proto") === "https"
          ? "https://"
          : "http://") +
        this._uws.req.getHeader("host") +
        this._uws.req.getUrl() +
        (query ? `?${query}` : "")
      );
    }

    get method() {
      return this._uws.req.getMethod().toUpperCase();
    }

    get signal() {
      if (!this.#abortSignal) {
        this.#abortSignal = new AbortController();
      }
      return this.#abortSignal.signal;
    }

    get bodyUsed() {
      return this.#bodyUsed;
    }

    get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
      if (this.method === "GET" || this.method === "HEAD") {
        return null;
      }
      if (!this.#bodyStream) {
        this.#bodyUsed = true;
        this.#bodyStream = new ReadableStream({
          start: (controller) => {
            this._uws.res.onData((chunk, isLast) => {
              controller.enqueue(new Uint8Array(chunk));
              if (isLast) {
                controller.close();
              }
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
      return this.bytes().then((buff) => buff.buffer);
    }

    blob(): Promise<Blob> {
      if (!this.#blobBody) {
        this.#blobBody = this.bytes().then((bytes) => {
          return new Blob([bytes], {
            type: this.headers.get("content-type") || "",
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

    json(): Promise<unknown> {
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
  new (uwsCtx: UWSRequestContext): ServerRequest;
};

async function _readStream(stream: ReadableStream) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(
    chunks.reduce((acc, chunk) => acc + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}
