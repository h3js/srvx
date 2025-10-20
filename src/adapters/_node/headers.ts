import type { NodeServerRequest } from "../../types.ts";
import { lazyInherit } from "../../_inherit.ts";
import type { NodeRequestContext } from "./request.ts";

// https://github.com/nodejs/node/blob/main/lib/_http_incoming.js

export type NodeRequestHeaders = InstanceType<typeof NodeRequestHeaders>;

export const NodeRequestHeaders: {
  new (nodeCtx: NodeRequestContext): globalThis.Headers;
} = /* @__PURE__ */ (() => {
  const NativeHeaders = globalThis.Headers;

  class Headers implements Partial<globalThis.Headers> {
    #req: NodeServerRequest;
    #headers: globalThis.Headers | undefined;

    constructor(nodeCtx: NodeRequestContext) {
      this.#req = nodeCtx.req;
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
      if (this.#headers) {
        return this.#headers.get(name);
      }
      const value = this.#req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value || null;
    }

    has(name: string): boolean {
      if (this.#headers) {
        return this.#headers.has(name);
      }
      return name.toLowerCase() in this.#req.headers;
    }

    getSetCookie(): string[] {
      if (this.#headers) {
        return this.#headers.getSetCookie();
      }
      const value = this.#req.headers["set-cookie"];
      return Array.isArray(value) ? value : value ? [value] : [];
    }

    *_entries(): HeadersIterator<[string, string]> {
      const rawHeaders = this.#req.rawHeaders;
      const len = rawHeaders.length;
      for (let i = 0; i < len; i += 2) {
        const key = rawHeaders[i];
        if (key.charCodeAt(0) === 58 /* : */) {
          continue;
        }
        const value = rawHeaders[i + 1];
        yield [key, value];
      }
    }

    entries(): HeadersIterator<[string, string]> {
      return this.#headers ? this.#headers.entries() : this._entries();
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
