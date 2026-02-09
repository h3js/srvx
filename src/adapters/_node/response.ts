import type { Readable as NodeReadable } from "node:stream";

import { lazyInherit } from "../../_inherit.ts";

// prettier-ignore
export type PreparedNodeResponseBody = string | Buffer | Uint8Array | DataView | ReadableStream | NodeReadable | undefined | null

export interface PreparedNodeResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: PreparedNodeResponseBody;
}

/**
 * Fast Response for Node.js runtime
 *
 * It is faster because in most cases it doesn't create a full Response instance.
 */
export const NodeResponse: {
  new (
    body?: BodyInit | null,
    init?: ResponseInit,
  ): globalThis.Response & {
    _toNodeResponse: () => PreparedNodeResponse;
  };
} = /* @__PURE__ */ (() => {
  const NativeResponse = globalThis.Response;

  const STATUS_CODES = globalThis.process?.getBuiltinModule?.("node:http")?.STATUS_CODES || {};

  class NodeResponse implements Partial<Response> {
    #body?: BodyInit | null;
    #init?: ResponseInit;
    #headers?: Headers;
    #response?: globalThis.Response;
    // Preserve Node.js-specific body (e.g. objects with .pipe) that can't be passed to native Response
    #nodeBody?: NodeReadable;

    constructor(body?: BodyInit | null, init?: ResponseInit) {
      this.#body = body;
      this.#init = init;
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeResponse;
    }

    get status(): number {
      return this.#response?.status || this.#init?.status || 200;
    }

    get statusText(): string {
      return (
        this.#response?.statusText || this.#init?.statusText || STATUS_CODES[this.status] || ""
      );
    }

    get headers(): Headers {
      if (this.#response) {
        return this.#response.headers;
      }
      if (this.#headers) {
        return this.#headers;
      }
      const initHeaders = this.#init?.headers;
      return (this.#headers =
        initHeaders instanceof Headers ? initHeaders : new Headers(initHeaders));
    }

    get ok(): boolean {
      if (this.#response) {
        return this.#response.ok;
      }
      const status = this.status;
      return status >= 200 && status < 300;
    }

    get _response(): globalThis.Response {
      if (this.#response) {
        return this.#response;
      }
      // Preserve Node.js-specific bodies (objects with .pipe) that can't be passed to native Response
      // These will be handled in _toNodeResponse() instead
      let bodyForNativeResponse: BodyInit | null | undefined = this.#body;
      if (this.#body && typeof (this.#body as unknown as NodeReadable).pipe === "function") {
        this.#nodeBody = this.#body as unknown as NodeReadable;
        bodyForNativeResponse = null;
      }
      this.#response = new NativeResponse(
        bodyForNativeResponse,
        this.#headers ? { ...this.#init, headers: this.#headers } : this.#init,
      );
      this.#init = undefined;
      this.#headers = undefined;
      this.#body = undefined;
      return this.#response;
    }

    _toNodeResponse() {
      // Status
      const status = this.status;
      const statusText = this.statusText;

      // Body
      let body: PreparedNodeResponseBody;
      let contentType: string | undefined | null;
      let contentLength: string | number | undefined | null;
      // Check for preserved Node.js-specific body first (e.g. from clone() scenario)
      if (this.#nodeBody) {
        body = this.#nodeBody;
      } else if (this.#response) {
        body = this.#response.body;
      } else if (this.#body) {
        if (this.#body instanceof ReadableStream) {
          body = this.#body;
        } else if (typeof this.#body === "string") {
          body = this.#body;
          contentType = "text/plain; charset=UTF-8";
          contentLength = Buffer.byteLength(this.#body);
        } else if (this.#body instanceof ArrayBuffer) {
          body = Buffer.from(this.#body);
          contentLength = this.#body.byteLength;
        } else if (this.#body instanceof Uint8Array) {
          body = this.#body;
          contentLength = this.#body.byteLength;
        } else if (this.#body instanceof DataView) {
          body = Buffer.from(this.#body.buffer);
          contentLength = this.#body.byteLength;
        } else if (this.#body instanceof Blob) {
          body = this.#body.stream();
          contentType = this.#body.type;
          contentLength = this.#body.size;
        } else if (typeof (this.#body as unknown as NodeReadable).pipe === "function") {
          body = this.#body as unknown as NodeReadable;
        } else {
          body = this._response.body;
        }
      }

      // Headers
      const headers: [string, string][] = [];
      const initHeaders = this.#init?.headers;
      const headerEntries =
        this.#response?.headers ||
        this.#headers ||
        (initHeaders
          ? Array.isArray(initHeaders)
            ? initHeaders
            : initHeaders?.entries
              ? (initHeaders as Headers).entries()
              : // prettier-ignore
                Object.entries(initHeaders).map(([k, v]) => [k.toLowerCase(), v])
          : undefined);
      let hasContentTypeHeader: boolean | undefined;
      let hasContentLength: boolean | undefined;
      if (headerEntries) {
        for (const [key, value] of headerEntries) {
          if (Array.isArray(value)) {
            for (const v of value) {
              headers.push([key, v]);
            }
          } else {
            headers.push([key, value]);
          }
          if (key === "content-type") {
            hasContentTypeHeader = true;
          } else if (key === "content-length") {
            hasContentLength = true;
          }
        }
      }
      if (contentType && !hasContentTypeHeader) {
        headers.push(["content-type", contentType]);
      }
      if (contentLength && !hasContentLength) {
        headers.push(["content-length", String(contentLength)]);
      }

      // Free up memory
      this.#init = undefined;
      this.#headers = undefined;
      this.#response = undefined;
      this.#body = undefined;
      this.#nodeBody = undefined;

      return {
        status,
        statusText,
        headers,
        body,
      };
    }
  }

  lazyInherit(NodeResponse.prototype, NativeResponse.prototype, "_response");

  Object.setPrototypeOf(NodeResponse, NativeResponse);
  Object.setPrototypeOf(NodeResponse.prototype, NativeResponse.prototype);

  return NodeResponse as any;
})();

export type NodeResponse = InstanceType<typeof NodeResponse>;
