import { lazyInherit } from "./_inherit.ts";

export type URLInit = {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
};

// Matches paths that need native URL normalization (i.e. where the verbatim
// fast path would diverge from `new URL()` for a target Node can actually
// deliver). Native percent-encodes/rewrites these in the path; the fast path
// would not:
// - dot segments (. / .. / %2e variants)
// - backslashes (rewritten to `/` for special schemes)
// - fragment delimiter (#) which the fast path does not split on
// - path percent-encode set chars: ^ " < > ` { }
// - non-ASCII characters
// (Control chars and space are rejected by Node's HTTP parser, so unreachable.)
const _needsNormRE =
  /(?:(?:^|\/)(?:\.|\.\.|%2e|%2e\.|\.%2e|%2e%2e)(?:\/|$))|[\\^#"<>{}`\x80-\uffff]/i;

// Query percent-encode set chars the WHATWG URL parser rewrites but the verbatim
// fast path would keep raw. Native percent-encodes `" ' < >` in the query (note
// this set is narrower than the path set: `` ` `` `{` `}` are NOT encoded in the
// query); `#` starts a fragment the fast path must not fold into search. When any
// appears in the query \u2014 or, for a raw origin-form string, anywhere (`" < >` also
// need encoding in the path) \u2014 we deopt to native parsing.
// (Control chars and space are rejected by Node's HTTP parser, so unreachable.)
const _searchNeedsNormRE = /[#"'<>]/;

/**
 * URL wrapper with fast paths to access to the following props:
 *
 *  - `url.pathname`
 *  - `url.search`
 *  - `url.searchParams`
 *  - `url.protocol`
 *
 * **NOTES:**
 *
 * - It is assumed that the input URL is **already encoded** and formatted from an HTTP request. A fragment (`#`), while not valid in an origin-form request target, is handled via full URL parsing.
 * - Triggering the setters or getters on other props will deoptimize to full URL parsing.
 * - Changes to `searchParams` will be discarded as we don't track them.
 */
export const FastURL: { new (url: string | URLInit): URL & { _url: URL } } =
  /* @__PURE__ */ (() => {
    const NativeURL = globalThis.URL;

    const FastURL = class URL implements Partial<globalThis.URL> {
      #url?: globalThis.URL;
      #href?: string;
      #protocol?: string;
      #host?: string;
      #pathname?: string;
      #search?: string;
      #searchParams?: URLSearchParams;
      #pos?: [protocol: number, pathname: number, query: number];

      constructor(url: string | URLInit) {
        if (typeof url === "string") {
          const isOriginForm = url[0] === "/";
          if (isOriginForm && !_searchNeedsNormRE.test(url)) {
            this.#href = url;
          } else {
            // Absolute-form, or a target with a fragment (#) / query percent-encode
            // set chars (" ' < >) that need full parsing to match native.
            this.#url = new NativeURL(isOriginForm ? `http://localhost${url}` : url);
          }
        } else if (
          _needsNormRE.test(url.pathname) ||
          (url.search && _searchNeedsNormRE.test(url.search))
        ) {
          this.#url = new NativeURL(
            `${url.protocol || "http:"}//${url.host || "localhost"}${url.pathname}${url.search || ""}`,
          );
        } else {
          this.#protocol = url.protocol;
          this.#host = url.host;
          this.#pathname = url.pathname;
          this.#search = url.search;
        }
      }

      static [Symbol.hasInstance](val: unknown) {
        return val instanceof NativeURL;
      }

      get _url(): globalThis.URL {
        if (this.#url) {
          return this.#url;
        }
        this.#url = new NativeURL(this.href);
        this.#href = undefined;
        this.#protocol = undefined;
        this.#host = undefined;
        this.#pathname = undefined;
        this.#search = undefined;
        this.#searchParams = undefined;
        this.#pos = undefined;
        return this.#url;
      }

      get href(): string {
        if (this.#url) {
          return this.#url.href;
        }
        if (!this.#href) {
          this.#href = `${this.#protocol || "http:"}//${this.#host || "localhost"}${this.#pathname || "/"}${this.#search || ""}`;
        }
        return this.#href!;
      }

      #getPos(): [protocol: number, pathname: number, query: number] {
        if (!this.#pos) {
          const url = this.href;
          const protoIndex = url.indexOf("://");
          const pathnameIndex =
            protoIndex === -1 ? -1 /* deoptimize */ : url.indexOf("/", protoIndex + 4);
          const qIndex = pathnameIndex === -1 ? -1 : url.indexOf("?", pathnameIndex);
          this.#pos = [protoIndex, pathnameIndex, qIndex];
        }
        return this.#pos;
      }

      get pathname() {
        if (this.#url) {
          return this.#url.pathname;
        }
        if (this.#pathname === undefined) {
          const [, pathnameIndex, queryIndex] = this.#getPos();
          if (pathnameIndex === -1) {
            return this._url.pathname; // deoptimize
          }
          this.#pathname = this.href.slice(
            pathnameIndex,
            queryIndex === -1 ? undefined : queryIndex,
          );
        }
        return this.#pathname;
      }

      get search() {
        if (this.#url) {
          return this.#url.search;
        }
        if (this.#search === undefined) {
          const [, pathnameIndex, queryIndex] = this.#getPos();
          if (pathnameIndex === -1) {
            return this._url.search; // deoptimize
          }
          const url = this.href;
          this.#search =
            queryIndex === -1 || queryIndex === url.length - 1 ? "" : url.slice(queryIndex);
        }
        return this.#search;
      }

      get searchParams() {
        if (this.#url) {
          return this.#url.searchParams;
        }
        if (!this.#searchParams) {
          this.#searchParams = new URLSearchParams(this.search);
        }
        return this.#searchParams;
      }

      get protocol() {
        if (this.#url) {
          return this.#url.protocol;
        }
        if (this.#protocol === undefined) {
          const [protocolIndex] = this.#getPos();
          if (protocolIndex === -1) {
            return this._url.protocol; // deoptimize
          }
          const url = this.href;
          this.#protocol = url.slice(0, protocolIndex + 1);
        }
        return this.#protocol;
      }

      toString(): string {
        return this.href;
      }

      toJSON(): string {
        return this.href;
      }
    };

    lazyInherit(FastURL.prototype, NativeURL.prototype, "_url");

    Object.setPrototypeOf(FastURL.prototype, NativeURL.prototype);
    Object.setPrototypeOf(FastURL, NativeURL);

    return FastURL as any;
  })();
