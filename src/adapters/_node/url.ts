import type { NodeServerRequest } from "../../types.ts";
import { HOST_RE, forwardedHopValue } from "../../_trust-proxy.ts";
import { FastURL } from "../../_url.ts";

export { HOST_RE };

export class NodeRequestURL extends FastURL {
  constructor({ req, hops = 0 }: { req: NodeServerRequest; hops?: number }) {
    const path = req.url || "/";

    // Only honor client-supplied `X-Forwarded-*` hints when the request comes
    // through a trusted proxy (`hops > 0`); otherwise any client could spoof the
    // host or `https` on a plaintext connection. The real transport
    // (`encrypted`) and the on-the-wire `Host` header stay authoritative.
    // `hops` (the trusted hop count) selects the entry contributed by the
    // outermost trusted proxy from a comma-joined chain, mirroring `request.ip`.
    // A malformed forwarded host is ignored (fall back to the real `Host`),
    // matching the universal trustProxy plugin used on Bun/Deno.
    const trusted = hops > 0;
    const forwardedHost = forwardedHopValue(req.headers["x-forwarded-host"], hops);

    let host =
      (forwardedHost && HOST_RE.test(forwardedHost) ? forwardedHost : undefined) ||
      req.headers.host ||
      (req.headers[":authority"] as string);
    if (host && !HOST_RE.test(host)) {
      host = "_invalid_";
    } else if (!host) {
      if (req.socket) {
        host = `${req.socket.localFamily === "IPv6" ? "[" + req.socket.localAddress + "]" : req.socket.localAddress}:${req.socket?.localPort || "80"}`;
      } else {
        host = "localhost";
      }
    }

    // A proxy chain can join `X-Forwarded-Proto` into a comma-separated list, so
    // pick the trusted hop entry (via `forwardedHopValue`) rather than the raw
    // header. The HTTP/2 `:scheme` pseudo-header is always a single value.
    const forwardedProto = forwardedHopValue(req.headers["x-forwarded-proto"], hops);
    const protocol =
      (req.socket as any)?.encrypted ||
      forwardedProto === "https" ||
      (trusted && req.headers[":scheme"] === "https")
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
