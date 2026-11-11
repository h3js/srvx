import type { NodeServerRequest } from "../../types.ts";
import { lazyInherit } from "../../_inherit.ts";

/** Single-value under both HTTP/1 and HTTP/2 (see `_nonJoinedHeaders`). */
const _H1 = 1;
/** Single-value under HTTP/2 only (see `_nonJoinedHeaders`). */
const _H2 = 2;

/**
 * Header names Node.js treats as single-value: repeats keep only the FIRST
 * occurrence in `req.headers`, diverging from WHATWG Headers ", " join
 * semantics. `set-cookie` stays an array and `cookie` repeats join with "; "
 * under both protocols, so neither needs a fallback.
 *
 * - HTTP/1 (`IncomingMessage`): `matchKnownFields` in
 *   https://github.com/nodejs/node/blob/main/lib/_http_incoming.js
 * - HTTP/2 (`Http2ServerRequest`): `kSingleValueHeaders` (`kSingleValueFields`
 *   in newer versions) in
 *   https://github.com/nodejs/node/blob/main/lib/internal/http2/util.js — the
 *   HTTP/1 list minus `server`, plus the `_H2` entries below. Pseudo-headers
 *   are omitted (they never reach the fast path).
 *
 * Over-inclusion is safe — a hit only costs a `rawHeaders` scan — so `server`
 * also applies to HTTP/2, and `content-encoding` stays even though Node's main
 * branch (unreleased as of v26.1) no longer collapses it. `_H2` names are
 * skipped on HTTP/1 so lookups like `if-none-match` keep the scan-free fast
 * path there.
 */
const _nonJoinedHeaders = /* @__PURE__ */ new Map<string, number>([
  // HTTP/1 and HTTP/2
  ["age", _H1],
  ["authorization", _H1],
  ["content-length", _H1],
  ["content-type", _H1],
  ["etag", _H1],
  ["expires", _H1],
  ["from", _H1],
  ["host", _H1],
  ["if-modified-since", _H1],
  ["if-unmodified-since", _H1],
  ["last-modified", _H1],
  ["location", _H1],
  ["max-forwards", _H1],
  ["proxy-authorization", _H1],
  ["referer", _H1],
  ["retry-after", _H1],
  ["server", _H1],
  ["user-agent", _H1],
  // HTTP/2 only
  ["access-control-allow-credentials", _H2],
  ["access-control-max-age", _H2],
  ["access-control-request-method", _H2],
  ["content-encoding", _H2],
  ["content-language", _H2],
  ["content-location", _H2],
  ["content-md5", _H2],
  ["content-range", _H2],
  ["date", _H2],
  ["dnt", _H2],
  ["if-match", _H2],
  ["if-none-match", _H2],
  ["if-range", _H2],
  ["range", _H2],
  ["tk", _H2],
  ["upgrade-insecure-requests", _H2],
  ["x-content-type-options", _H2],
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
  new (req: NodeServerRequest): globalThis.Headers & {
    /** @internal See `_adopt` in the class body. */
    _adopt(headers: globalThis.Headers): void;
  };
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

    /**
     * Swap the backing store for the materialized native request's Headers so
     * this wrapper becomes a pure facade over it: previously-taken references
     * stay live and mutations through either view land in the single remaining
     * store. Called by `NodeRequest`'s `_request` getter.
     * @internal
     */
    _adopt(headers: globalThis.Headers) {
      this.#headers = headers;
    }

    get _headers() {
      if (!this.#headers) {
        const headers = new NativeHeaders();
        const rawHeaders = this.#req.rawHeaders;
        const len = rawHeaders.length;
        let cookie: string | undefined;
        for (let i = 0; i < len; i += 2) {
          const key = rawHeaders[i];
          if (key.charCodeAt(0) === 58 /* : */) {
            // HTTP/2 pseudo-header (`:method`, `:path`, …)
            continue;
          }
          const value = rawHeaders[i + 1];
          if (key.length === 6 && key.toLowerCase() === "cookie") {
            // HTTP/2 may split `cookie` into several fields (RFC 9113
            // §8.2.3); they must rejoin with "; " like Node's `req.headers`.
            // Joined here as not every runtime's native Headers special-cases
            // cookie on append (Deno joins with ", ").
            cookie = cookie === undefined ? value : `${cookie}; ${value}`;
            continue;
          }
          headers.append(key, value);
        }
        if (cookie !== undefined) {
          headers.append("cookie", cookie);
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
        // content-type, and on HTTP/2 also if-none-match, range, …) to their
        // first occurrence in `req.headers`, diverging from WHATWG ", " join
        // semantics. Deopt to the rawHeaders-materialized Headers only when
        // such a header actually repeats.
        const kind = _nonJoinedHeaders.get(lower);
        return kind !== undefined &&
          (kind === _H1 || this.#req.httpVersionMajor === 2) &&
          _isRepeated(this.#req.rawHeaders, lower)
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
