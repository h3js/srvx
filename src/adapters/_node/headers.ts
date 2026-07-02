import type { NodeServerRequest } from "../../types.ts";
import { lazyInherit } from "../../_inherit.ts";

// https://github.com/nodejs/node/blob/main/lib/_http_incoming.js

export type NodeRequestHeaders = InstanceType<typeof NodeRequestHeaders>;

export const NodeRequestHeaders: {
  new (req: NodeServerRequest): globalThis.Headers;
} = /* @__PURE__ */ (() => {
  const NativeHeaders = globalThis.Headers;

  class Headers implements Partial<globalThis.Headers> {
    #req: NodeServerRequest;
    #headers: globalThis.Headers | undefined;

    constructor(req: NodeServerRequest) {
      this.#req = req;
    }

    static [Symbol.hasInstance](val: unknown) {
      return val instanceof NativeHeaders;
    }

    get _headers() {
      if (!this.#headers) {
        const headers = new NativeHeaders();
        const rawHeaders = this.#req.rawHeaders;
        const len = rawHeaders.length;
        for (let i = 0; i < len; i += 2) {
          const key = rawHeaders[i];
          if (key.charCodeAt(0) === 58 /* : */) {
            continue;
          }
          const value = rawHeaders[i + 1];
          headers.append(key, value);
        }
        this.#headers = headers;
      }
      return this.#headers;
    }

    get(name: string): string | null {
      // Always read from the rawHeaders-materialized Headers: Node collapses
      // headers it treats as single-value (authorization, content-type, …) to
      // their first occurrence in `req.headers`, which diverges from WHATWG.
      return this._headers.get(name);
    }

    has(name: string): boolean {
      return this._headers.has(name);
    }

    getSetCookie(): string[] {
      return this._headers.getSetCookie();
    }

    entries(): HeadersIterator<[string, string]> {
      return this._headers.entries();
    }

    [Symbol.iterator](): HeadersIterator<[string, string]> {
      return this.entries();
    }
  }

  lazyInherit(Headers.prototype, NativeHeaders.prototype, "_headers");

  Object.setPrototypeOf(Headers, NativeHeaders);
  Object.setPrototypeOf(Headers.prototype, NativeHeaders.prototype);

  return Headers as any;
})();
