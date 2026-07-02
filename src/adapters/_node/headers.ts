import type { NodeServerRequest } from "../../types.ts";
import { lazyInherit } from "../../_inherit.ts";

// https://github.com/nodejs/node/blob/main/lib/_http_incoming.js

/**
 * Header names Node.js treats as single-value: repeats keep only the FIRST
 * occurrence in `req.headers`, diverging from WHATWG Headers ", " join
 * semantics. (https://nodejs.org/api/http.html#messageheaders — `set-cookie`
 * stays an array and `cookie` repeats join with "; " in both Node and the
 * Fetch spec, so neither needs a fallback.)
 */
const _nonJoinedHeaders = /* @__PURE__ */ new Set([
  "age",
  "authorization",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "from",
  "host",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
  "location",
  "max-forwards",
  "proxy-authorization",
  "referer",
  "retry-after",
  "server",
  "user-agent",
]);

// WHATWG header name token (RFC 9110 field-name)
const _validHeaderNameRE = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;

function _isRepeated(rawHeaders: string[], lowerName: string): boolean {
  let seen = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    if (key.length === lowerName.length && key.toLowerCase() === lowerName) {
      if (seen) {
        return true;
      }
      seen = true;
    }
  }
  return false;
}

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
      if (this.#headers) {
        return this.#headers.get(name);
      }
      const lower = name.toLowerCase();
      if (lower.charCodeAt(0) === 58 /* : */) {
        // HTTP/2 pseudo-header: invalid WHATWG name → native TypeError
        return this._headers.get(name);
      }
      const value = this.#req.headers[lower];
      if (typeof value === "string") {
        // Node collapses repeated single-value headers (authorization,
        // content-type, …) to their first occurrence in `req.headers`,
        // diverging from WHATWG ", " join semantics. Deopt to the
        // rawHeaders-materialized Headers only when such a header actually
        // repeats.
        return _nonJoinedHeaders.has(lower) && _isRepeated(this.#req.rawHeaders, lower)
          ? this._headers.get(name)
          : value;
      }
      if (Array.isArray(value)) {
        // Only set-cookie is array-valued in `req.headers`
        return value.join(", ");
      }
      // Absent, or a non-string artifact from `req.headers`'s prototype
      // (`toString`, …). A real `__proto__` header never lands as an own key
      // (the prototype accessor swallows Node's assignment) and invalid names
      // need native error semantics — both read from the materialized Headers.
      return lower !== "__proto__" && _validHeaderNameRE.test(name)
        ? null
        : this._headers.get(name);
    }

    has(name: string): boolean {
      if (this.#headers) {
        return this.#headers.has(name);
      }
      const lower = name.toLowerCase();
      if (lower.charCodeAt(0) === 58 /* : */) {
        // HTTP/2 pseudo-header: invalid WHATWG name → native TypeError
        return this._headers.has(name);
      }
      // Presence is unaffected by Node's duplicate collapsing/joining.
      // `hasOwn` guards against `req.headers` prototype hits (`toString`, …).
      if (Object.hasOwn(this.#req.headers, lower)) {
        return true;
      }
      // `__proto__` never lands as an own key (see get()); invalid names need
      // native error semantics.
      return lower !== "__proto__" && _validHeaderNameRE.test(name)
        ? false
        : this._headers.has(name);
    }

    getSetCookie(): string[] {
      if (this.#headers) {
        return this.#headers.getSetCookie();
      }
      // Node always materializes set-cookie as an array of every occurrence.
      const value = this.#req.headers["set-cookie"];
      return Array.isArray(value) ? value.slice() : value ? [value] : [];
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
