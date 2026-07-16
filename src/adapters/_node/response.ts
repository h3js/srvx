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
      // Native `Response` validates `init.status` at construction and throws a
      // `RangeError` for anything outside 200-599. Because the fast path never
      // builds a native `Response`, that check would otherwise be skipped and an
      // out-of-range status silently reach the wire (or `status: 0` be coerced
      // to 200 by the getter). Validate once here to match native semantics
      // while keeping the hot `status` getter free of range checks.
      if (init !== undefined) {
        const status = init.status;
        if (status !== undefined) {
          // `& 0xffff` reproduces WebIDL's `unsigned short` (ToUint16) coercion
          // used by native `Response`: it truncates toward zero and wraps mod
          // 2^16, so e.g. `"204"` -> 204, `599.9` -> 599, `65736` -> 200.
          const code = (status as number) & 0xffff;
          if (code < 200 || code > 599) {
            throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`);
          }
        }
      }
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeResponse;
    }

    get status(): number {
      // `??` (not `||`): the constructor has already rejected any out-of-range
      // status, so a stored value is always a valid 200-599 code that must not
      // be replaced by the `200` fallback.
      return this.#response?.status ?? this.#init?.status ?? 200;
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
