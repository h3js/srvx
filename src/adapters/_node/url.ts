import type { NodeServerRequest } from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { isTrustedProxy } from "../../_trust-proxy.ts";
import { FastURL } from "../../_url.ts";

/**
 * Validates an HTTP Host header value (domain, IPv4, or bracketed IPv6) with optional port.
 * Intended for preliminary filtering invalid values like "localhost:3000/foobar?"
 */
export const HOST_RE: RegExp =
  /^(\[(?:[A-Fa-f0-9:.]+)\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|(?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/;

export class NodeRequestURL extends FastURL {
  constructor({ req, trustProxy }: { req: NodeServerRequest; trustProxy?: TrustProxyOption }) {
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

    // Only honor client-supplied forwarded protocol hints when the request
    // comes through a trusted proxy; otherwise any client could spoof `https`
    // on a plaintext connection. The real transport (`encrypted`) is always
    // authoritative.
    const trusted = isTrustedProxy(trustProxy, req.socket?.remoteAddress);
    const protocol =
      (req.socket as any)?.encrypted ||
      (trusted &&
        (req.headers["x-forwarded-proto"] === "https" || req.headers[":scheme"] === "https"))
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
    } else if (path === "*") {
      // RFC 9110 §7.1 asterisk-form (`OPTIONS *`): surface as `/*`, matching
      // Deno. Other non-conforming targets are rejected by the adapter.
      super({ protocol, host, pathname: "/*", search: "" });
    } else {
      // absolute-form (e.g. proxy request)
      super(path);
    }
  }
}
