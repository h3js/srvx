import { kNodeInspect } from "./_common.ts";

import type { NodeServerRequest, NodeServerResponse } from "../../types.ts";

export const NodeRequestURL: {
  new (nodeCtx: { req: NodeServerRequest; res?: NodeServerResponse }): URL;
} = /* @__PURE__ */ (() => {
  const _URL = class URL implements Partial<globalThis.URL> {
    _node: {
      req: NodeServerRequest;
      res?: NodeServerResponse;
    };

    _hash = "";
    _username = "";
    _password = "";
    _protocol?: string;
    _hostname?: string;
    _port?: string;

    _pathname?: string;
    _search?: string;
    _searchParams?: URLSearchParams;

    constructor(nodeCtx: { req: NodeServerRequest; res?: NodeServerResponse }) {
      this._node = nodeCtx;
    }

    get hash() {
      return this._hash;
    }

    set hash(value: string) {
      this._hash = value;
    }

    get username() {
      return this._username;
    }

    set username(value: string) {
      this._username = value;
    }

    get password() {
      return this._password;
    }

    set password(value: string) {
      this._password = value;
    }

    // host
    get host() {
      return (
        this._node.req.headers.host ||
        (this._node.req.headers[":authority"] as string) ||
        ""
      );
    }
    set host(value: string) {
      this._hostname = undefined;
      this._port = undefined;
      this._node.req.headers.host = value;
    }

    // hostname
    get hostname() {
      if (this._hostname === undefined) {
        const [hostname, port] = parseHost(this._node.req.headers.host);
        if (this._port === undefined && port) {
          this._port = String(Number.parseInt(port) || "");
        }
        this._hostname = hostname || "localhost";
      }
      return this._hostname;
    }
    set hostname(value: string) {
      this._hostname = value;
    }

    // port
    get port() {
      if (this._port === undefined) {
        const [hostname, port] = parseHost(this._node.req.headers.host);
        if (this._hostname === undefined && hostname) {
          this._hostname = hostname;
        }
        this._port = port || String(this._node.req.socket?.localPort || "");
      }
      return this._port;
    }
    set port(value: string) {
      this._port = String(Number.parseInt(value) || "");
    }

    // pathname
    get pathname() {
      if (this._pathname === undefined) {
        const [pathname, search] = parsePath(this._node.req.url || "/");
        this._pathname = pathname;
        if (this._search === undefined) {
          this._search = search;
        }
      }
      return this._pathname;
    }
    set pathname(value: string) {
      if (value[0] !== "/") {
        value = "/" + value;
      }
      if (value === this._pathname) {
        return;
      }
      this._pathname = value;
      this._node.req.url = value + this.search;
    }

    // search
    get search() {
      if (this._search === undefined) {
        const [pathname, search] = parsePath(this._node.req.url || "/");
        this._search = search;
        if (this._pathname === undefined) {
          this._pathname = pathname;
        }
      }
      return this._search;
    }
    set search(value: string) {
      if (value === "?") {
        value = "";
      } else if (value && value[0] !== "?") {
        value = "?" + value;
      }
      if (value === this._search) {
        return;
      }
      this._search = value;
      this._searchParams = undefined;
      this._node.req.url = this.pathname + value;
    }

    // searchParams
    get searchParams() {
      if (!this._searchParams) {
        this._searchParams = new URLSearchParams(this.search);
      }
      return this._searchParams;
    }
    set searchParams(value: URLSearchParams) {
      this._searchParams = value;
      this._search = value.toString();
    }

    // protocol
    get protocol() {
      if (!this._protocol) {
        this._protocol =
          (this._node.req.socket as any)?.encrypted ||
          this._node.req.headers["x-forwarded-proto"] === "https"
            ? "https:"
            : "http:";
      }
      return this._protocol;
    }
    set protocol(value) {
      this._protocol = value;
    }

    // origin
    get origin() {
      return `${this.protocol}//${this.host}`;
    }
    set origin(_value) {
      // ignore
    }

    // href
    get href() {
      return `${this.protocol}//${this.host}${this.pathname}${this.search}`;
    }
    set href(value: string) {
      const _url = new globalThis.URL(value);
      this._protocol = _url.protocol;
      this.username = _url.username;
      this.password = _url.password;
      this._hostname = _url.hostname;
      this._port = _url.port;
      this.pathname = _url.pathname;
      this.search = _url.search;
      this.hash = _url.hash;
    }

    toString(): string {
      return this.href;
    }

    toJSON(): string {
      return this.href;
    }

    get [Symbol.toStringTag]() {
      return "URL";
    }

    [kNodeInspect]() {
      return this.href;
    }
  };

  Object.setPrototypeOf(_URL.prototype, globalThis.URL.prototype);

  return _URL;
})();

function parsePath(input: string): [pathname: string, search: string] {
  const url = (input || "/").replace(/\\/g, "/");
  const qIndex = url.indexOf("?");
  if (qIndex === -1) {
    return [url, ""];
  }
  return [url.slice(0, qIndex), url.slice(qIndex)];
}

function parseHost(host: string | undefined): [hostname: string, port: string] {
  const s = (host || "").split(":");
  return [s[0], String(Number.parseInt(s[1]) || "")];
}
