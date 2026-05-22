import type { NodeServerRequest } from "../../types.ts";
import { FastURL } from "../../_url.ts";

/**
 * Validates an HTTP Host header value (domain, IPv4, or bracketed IPv6) with optional port.
 * Intended for preliminary filtering invalid values like "localhost:3000/foobar?"
 */
export const HOST_RE: RegExp =
  /^(\[(?:[A-Fa-f0-9:.]+)\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|(?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/;

export class NodeRequestURL extends FastURL {
  #req: NodeServerRequest;

  constructor({ req }: { req: NodeServerRequest }) {
    const path = req.url || "/";

    let host = req.headers.host || (req.headers[":authority"] as string);
    if (host && !HOST_RE.test(host)) {
      host = "_invalid_";
    } else if (!host) {
      if (req.socket) {
        host = `${req.socket.localFamily === "IPv6" ? "[" + req.socket.localAddress + "]" : req.socket.localAddress}:${req.socket?.localPort || "80"}`;
      } else {
        host = "localhost";
      }
    }

    const protocol =
      (req.socket as any)?.encrypted ||
      req.headers["x-forwarded-proto"] === "https" ||
      req.headers[":scheme"] === "https"
        ? "https:"
        : "http:";

    if (path[0] === "/") {
      // origin-form: /path?query
      const qIndex = path.indexOf("?");
      super({
        protocol,
        host,
        pathname: qIndex === -1 ? path : path.slice(0, qIndex) || "/",
        search: qIndex === -1 ? "" : path.slice(qIndex) || "",
      });
    } else if (URL.canParse(path)) {
      // absolute-form (e.g. proxy request)
      super(path);
    } else {
      // Anything else llhttp admits but URL cannot parse — notably the
      // asterisk-form request-target (RFC 9110 §7.1, `OPTIONS *`) and
      // similar non-conforming targets like `**` or `*foo`. These have
      // no Fetch URL representation. Preserve the literal as a pathname
      // (prefixed with "/") so handlers can still observe it, falling
      // back to "/" if even that won't parse — never crash the process.
      const qIndex = path.indexOf("?");
      const rawPath = qIndex === -1 ? path : path.slice(0, qIndex);
      const rawQuery = qIndex === -1 ? "" : path.slice(qIndex);
      const candidate = "/" + rawPath;
      const synthesized = URL.canParse(`${protocol}//${host}${candidate}${rawQuery}`)
        ? candidate
        : "/";
      super({
        protocol,
        host,
        pathname: synthesized,
        search: synthesized === candidate ? rawQuery : "",
      });
    }
    this.#req = req;
  }

  override get pathname(): string {
    return super.pathname;
  }

  override set pathname(value: string) {
    this._url.pathname = value;
    this.#req.url = this._url.pathname + this._url.search;
  }
}
