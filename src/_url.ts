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
// - control chars, space, and DEL (\x00-\x20, \x7f)
// - non-ASCII characters
// (HTTP/1's parser rejects control chars and space, but the Node adapter also
// serves HTTP/2, where a raw `:path` reaches the handler verbatim, so they must
// trigger normalization too \u2014 native percent-encodes/strips them.)
const _needsNormRE =
  // oxlint-disable-next-line no-control-regex -- control chars/DEL are intentional (HTTP/2-reachable)
  /(?:(?:^|\/)(?:\.|\.\.|%2e|%2e\.|\.%2e|%2e%2e)(?:\/|$))|[\\^#"<>{}`\x00-\x20\x7f-\uffff]/i;

// Query percent-encode set chars the WHATWG URL parser rewrites but the verbatim
// fast path would keep raw. Native percent-encodes `" ' < >` in the query (note
// this set is narrower than the path set: `` ` `` `{` `}` are NOT encoded in the
// query); `#` starts a fragment the fast path must not fold into search. When any
// appears in the query \u2014 or, for a raw origin-form string, anywhere (`" < >` also
// need encoding in the path) \u2014 we deopt to native parsing. Over HTTP/2 (also
// served by the Node adapter) control chars, space, and DEL reach the handler
// raw, so the class covers `\x00-\x20` and `\x7f-\uffff` (DEL + all non-ASCII)
// too \u2014 native percent-encodes/strips these.
// oxlint-disable-next-line no-control-regex -- control chars/DEL are intentional (HTTP/2-reachable)
const _searchNeedsNormRE = /[#"'<>\x00-\x20\x7f-\uffff]/;

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
 * - Mutating `searchParams` deoptimizes to full URL parsing; changes are reflected in `search`/`href` and the same `searchParams` object is kept across deopts (native `URL` semantics).
 */
export const FastURL: { new (url: string | URLInit): URL & { _url: URL } } =
  /* @__PURE__ */ (() => {
    const NativeURL = globalThis.URL;
    const NativeSearchParams = globalThis.URLSearchParams;

    /**
     * Facade handed out by `FastURL`'s `searchParams` getter on the fast path so
     * the spec's "same object for the lifetime of the URL" identity holds across
     * a later deopt. Reads are served from a params object lazily parsed off the
     * owner's search string; mutations materialize the owner's native URL first
     * (the owner then swaps this facade's backing store to that URL's
     * `searchParams` via `_adopt`) so the write lands in the single store
     * `search`/`href` serialize from — matching native `URL` semantics.
     */
    const FastURLSearchParams: {
      new (owner: { search: string; _url: globalThis.URL }): globalThis.URLSearchParams & {
        /** @internal See `_adopt` in the class body. */
        _adopt(params: globalThis.URLSearchParams): void;
      };
    } = class URLSearchParams implements Partial<globalThis.URLSearchParams> {
      #owner: { search: string; _url: globalThis.URL };
      #params?: globalThis.URLSearchParams;

      constructor(owner: { search: string; _url: globalThis.URL }) {
        this.#owner = owner;
      }

      static [Symbol.hasInstance](val: unknown) {
        return val instanceof NativeSearchParams;
      }

      /**
       * Swap the backing store for the materialized native URL's `searchParams`
       * so this facade becomes a pure view over it: previously-taken references
       * stay live and mutations through either view land in the single remaining
       * store (mirrors `NodeRequestHeaders`'s `_adopt`). Called by `FastURL`'s
       * `_url` getter.
       * @internal
       */
      _adopt(params: globalThis.URLSearchParams) {
        this.#params = params;
      }

      get _params(): globalThis.URLSearchParams {
        return (this.#params ??= new NativeSearchParams(this.#owner.search));
      }

      // Writes must be reflected by the owner URL (`search`/`href`) like
      // native. Materializing `_url` makes the owner adopt its native
      // `searchParams` as this facade's store (a pre-adoption `#params` parsed
      // from the same search string is safely discarded — it cannot have been
      // mutated), so the write below lands in the linked store.
      #mutable(): globalThis.URLSearchParams {
        void this.#owner._url;
        return this.#params!;
      }

      append(name: string, value: string): void {
        this.#mutable().append(name, value);
      }

      set(name: string, value: string): void {
        this.#mutable().set(name, value);
      }

      delete(name: string, value?: string): void {
        this.#mutable().delete(name, value);
      }

      sort(): void {
        this.#mutable().sort();
      }
    } as any;

    lazyInherit(FastURLSearchParams.prototype, NativeSearchParams.prototype, "_params");

    Object.setPrototypeOf(FastURLSearchParams.prototype, NativeSearchParams.prototype);
    Object.setPrototypeOf(FastURLSearchParams, NativeSearchParams);

    const FastURL = class URL implements Partial<globalThis.URL> {
      #url?: globalThis.URL;
      #href?: string;
      #protocol?: string;
      #host?: string;
      #pathname?: string;
      #search?: string;
      #searchParams?: InstanceType<typeof FastURLSearchParams>;
      #pos?: [protocol: number, pathname: number, query: number];

      constructor(url: string | URLInit) {
        if (typeof url === "string") {
          const isOriginForm = url[0] === "/";
          if (isOriginForm && !_searchNeedsNormRE.test(url)) {
            // Store a full absolute href (scheme + host) so `#getPos()` finds
            // `://` and the getters resolve against `http://localhost` semantics,
            // matching the `URLInit` and deopt paths below.
            this.#href = `http://localhost${url}`;
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
        this.#pos = undefined;
        // Keep #searchParams: the handed-out facade stays this URL's
        // `searchParams` identity; it now fronts the native URL's params so
        // previously-taken references stay live and mutations through either
        // view land in the single remaining store.
        this.#searchParams?._adopt(this.#url.searchParams);
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
        // The facade (created on the fast path) stays the answer even after a
        // deopt — it fronts the native URL's params from then on (see `_url`).
        if (this.#searchParams) {
          return this.#searchParams;
        }
        if (this.#url) {
          return this.#url.searchParams;
        }
        return (this.#searchParams = new FastURLSearchParams(this));
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
