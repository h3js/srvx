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
    if (path[0] === "/") {
      const qIndex = path.indexOf("?");
      const pathname = qIndex === -1 ? path : path?.slice(0, qIndex) || "/";
      const search = qIndex === -1 ? "" : path?.slice(qIndex) || "";

      let host = req.headers.host || (req.headers[":authority"] as string);
      if (host) {
        if (!HOST_RE.test(host)) {
          throw new TypeError(`Invalid host header: ${host}`);
        }
      } else if (req.socket) {
        host = `${req.socket.localFamily === "IPv6" ? "[" + req.socket.localAddress + "]" : req.socket.localAddress}:${req.socket?.localPort || "80"}`;
      } else {
        host = "localhost";
      }

      const protocol =
        (req.socket as any)?.encrypted ||
        req.headers["x-forwarded-proto"] === "https" ||
        req.headers[":scheme"] === "https"
          ? "https:"
          : "http:";

      super({
        protocol,
        host,
        pathname,
        search,
      });
    } else {
      super(path);
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
