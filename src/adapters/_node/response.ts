import { PassThrough, Readable as NodeReadable, Writable as NodeWritable } from "node:stream";

import { lazyInherit } from "../../_inherit.ts";

// prettier-ignore
export type PreparedNodeResponseBody = string | Buffer | Uint8Array | DataView | ReadableStream | NodeReadable | undefined | null

export interface PreparedNodeResponse {
  status: number;
  statusText: string;
  /** Flat rawHeaders-style list: `[name1, value1, name2, value2, …]` */
  headers: string[];
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
  json(
    data: unknown,
    init?: ResponseInit,
  ): globalThis.Response & { _toNodeResponse: () => PreparedNodeResponse };
} = /* @__PURE__ */ (() => {
  const NativeResponse = globalThis.Response;

  class NodeResponse implements Partial<Response> {
    #body?: BodyInit | null;
    #init?: ResponseInit;
    #headers?: Headers;
    #response?: globalThis.Response;

    constructor(body?: BodyInit | null, init?: ResponseInit) {
      this.#body = body;
      this.#init = init;
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeResponse;
    }

    static json(data: unknown, init?: ResponseInit) {
      const body = JSON.stringify(data);
      if (body === undefined) {
        throw new TypeError("Value is not JSON serializable");
      }
      let headers = init?.headers;
      if (!headers) {
        headers = { "content-type": "application/json" };
      } else {
        const merged = new Headers(headers);
        if (!merged.has("content-type")) {
          merged.set("content-type", "application/json");
        }
        headers = merged;
      }
      return new NodeResponse(body, init ? { ...init, headers } : { headers });
    }

    get status(): number {
      return this.#response?.status || this.#init?.status || 200;
    }

    get statusText(): string {
      // Default to the spec's empty reason phrase (matching native `Response`,
      // Bun and Deno) rather than Node's `STATUS_CODES` phrase (e.g. "OK").
      // Node uses an explicit "" verbatim in `writeHead`, so the wire status
      // line carries an empty reason phrase too (legal per RFC 9112).
      return this.#response?.statusText || this.#init?.statusText || "";
    }

    get headers(): Headers {
      if (this.#response) {
        return this.#response.headers;
      }
      if (this.#headers) {
        return this.#headers;
      }
      // Copy the init headers instead of adopting the caller's instance, so that
      // mutating `res.headers` can't leak back into a shared "template" Headers
      // (CORS/security presets, per-route defaults), matching native `Response`.
      // The copy is lazy: it only happens once someone reaches for `.headers`.
      // The read-only path (`_toNodeResponse()`) iterates `#init.headers`
      // directly and stays zero-copy.
      return (this.#headers = new Headers(this.#init?.headers));
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

      // Undici accepts standard Response body or async iterators (which Node Readable implements too).
      // Pipeable objects, like React's renderToPipeableStream, do not implement async iterators.
      let body: BodyInit | null | undefined = this.#body;
      if (
        body &&
        typeof (body as unknown as NodeReadable).pipe === "function" &&
        !(body instanceof NodeReadable)
      ) {
        const stream = new PassThrough();
        (body as unknown as NodeReadable).pipe(stream);
        const abort = (body as unknown as { abort?: () => void }).abort;
        if (abort) {
          stream.once("close", () => abort());
        }
        body = stream as unknown as BodyInit;
      }

      this.#response = new NativeResponse(
        body,
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
      if (this.#response) {
        body = this.#response.body;
      } else if (this.#body != null) {
        // `!= null` (not a truthy check): an empty-string body is falsy but must
        // still receive the implicit `text/plain` content-type and a
        // `content-length: 0`, matching native `Response("")`.
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
          // Only the view's window (byteOffset..byteOffset+byteLength) is part of
          // the body. `Buffer.from(view.buffer)` would send the whole underlying
          // ArrayBuffer while content-length is the view length — wrong bytes to
          // the client and stray bytes left in a keep-alive connection.
          body = Buffer.from(this.#body.buffer, this.#body.byteOffset, this.#body.byteLength);
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

      // Headers (flat rawHeaders-style list — avoids a per-response flatten in writeHead)
      const headers: string[] = [];
      const initHeaders = this.#init?.headers;
      const headerEntries =
        this.#response?.headers ||
        this.#headers ||
        (initHeaders
          ? Array.isArray(initHeaders)
            ? initHeaders
            : initHeaders?.entries
              ? (initHeaders as Headers).entries()
              : Object.entries(initHeaders)
          : undefined);
      let hasContentTypeHeader: boolean | undefined;
      let hasContentLength: boolean | undefined;
      if (headerEntries) {
        for (const [key, value] of headerEntries) {
          // Normalize names once: enables case-insensitive content-type /
          // content-length dedup and matches native Response header casing.
          const lowerKey = typeof key === "string" ? key.toLowerCase() : String(key);
          if (Array.isArray(value)) {
            for (const v of value) {
              headers.push(lowerKey, v);
            }
          } else {
            headers.push(lowerKey, value);
          }
          if (lowerKey === "content-type") {
            hasContentTypeHeader = true;
          } else if (lowerKey === "content-length") {
            hasContentLength = true;
          }
        }
      }
      if (contentType && !hasContentTypeHeader) {
        headers.push("content-type", contentType);
      }
      // `!= null` so a computed `content-length: 0` (e.g. an empty-string body)
      // is emitted, matching native `Response`.
      if (contentLength != null && !hasContentLength) {
        headers.push("content-length", String(contentLength));
      }

      // Free up memory
      this.#init = undefined;
      this.#headers = undefined;
      this.#response = undefined;
      this.#body = undefined;

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
