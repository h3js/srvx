import { lazyInherit } from "./_inherit.ts";

export type URLInit = {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
};

/**
 * Wrapper for URL with fast path access to `.pathname`, `.search` and `.searchParams` props.
 *
 * **NOTES:**
 *
 * - It is assumed that the input URL is already ecoded and formatted from an HTTP request and contains no hash.
 * - Triggering the setters or getters on other props will deoptimize to full URL parsing.
 * - Changes to `searchParams` will be discarded as we don't track them.
 */
export const FastURL: { new (url: string | URLInit): URL } =
  /* @__PURE__ */ (() => {
    const NativeURL = globalThis.URL;

    const FastURL = class URL implements Partial<globalThis.URL> {
      #parsedURL: globalThis.URL | undefined;

      #href?: string;
      #protocol?: string;
      #host?: string;
      #pathname?: string;
      #search?: string;
      #searchParams?: URLSearchParams;
      #pos?: { pathname: number; query: number };

      constructor(url: string | URLInit) {
        if (typeof url === "string") {
          this.#href = url;
        } else {
          this.#protocol = url.protocol;
          this.#host = url.host;
          this.#pathname = url.pathname;
          this.#search = url.search;
        }
      }

      get _url(): globalThis.URL {
        if (this.#parsedURL) {
          return this.#parsedURL;
        }
        this.#parsedURL = new NativeURL(this.href);
        this.#href = undefined;
        this.#protocol = undefined;
        this.#host = undefined;
        this.#pathname = undefined;
        this.#search = undefined;
        this.#searchParams = undefined;
        this.#pos = undefined;
        return this.#parsedURL;
      }

      get href(): string {
        if (this.#parsedURL) {
          return this.#parsedURL.href;
        }
        if (!this.#href) {
          this.#href = `${this.#protocol || "http:"}//${this.#host || "localhost"}${this.#pathname || "/"}${this.#search || ""}`;
        }
        return this.#href!;
      }

      #getPos(): { pathname: number; query: number } {
        if (!this.#pos) {
          const url = this.href;
          const protoIndex = url.indexOf("://");
          const pIndex =
            protoIndex === -1
              ? -1 /* deoptimize */
              : url.indexOf("/", protoIndex + 4);
          const qIndex = pIndex === -1 ? -1 : url.indexOf("?", pIndex);
          this.#pos = { pathname: pIndex, query: qIndex };
        }
        return this.#pos;
      }

      get pathname() {
        if (this.#parsedURL) {
          return this.#parsedURL.pathname;
        }
        if (this.#pathname === undefined) {
          const pos = this.#getPos();
          if (pos.pathname === -1) {
            return this._url.pathname; // deoptimize
          }
          this.#pathname = this.href.slice(
            pos.pathname,
            pos.query === -1 ? undefined : pos.query,
          );
        }
        return this.#pathname;
      }

      get search() {
        if (this.#parsedURL) {
          return this.#parsedURL.search;
        }
        if (this.#search === undefined) {
          const pos = this.#getPos();
          if (pos.pathname === -1) {
            return this._url.search; // deoptimize
          }
          const url = this.href;
          this.#search =
            pos.query === -1 || pos.query === url.length - 1
              ? ""
              : url.slice(pos.query);
        }
        return this.#search;
      }

      get searchParams() {
        if (this.#parsedURL) {
          return this.#parsedURL.searchParams;
        }
        if (!this.#searchParams) {
          this.#searchParams = new URLSearchParams(this.search);
        }
        return this.#searchParams;
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
