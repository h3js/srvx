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
      // absolute-form (RFC 9112 §3.2.2), e.g. `GET https://host/p HTTP/1.1`.
      // Origin servers MUST accept it and its authority supersedes `Host` — but
      // srvx is not a proxy, so it must not become a way around the guarantees
      // above. The transport-derived `protocol` stays authoritative (a client
      // must never be able to claim `https:` on a plaintext socket, or `http:`
      // on TLS), the request-line authority is `HOST_RE`-validated exactly like
      // a `Host` header, and userinfo is dropped (`new Request()` throws on a
      // URL that includes credentials — see `_request` in ./request.ts, which
      // would otherwise turn any such target into an unauthenticated 500).
      // `serve()` additionally answers 400 for targets that aren't http(s)
      // absolute-form; this branch is what keeps `toNodeHandler`, which has no
      // target gate, safe as well.
      // (`URL.parse` is unusable here: `engines.node` is >=20.16.0 and
      // `URL.parse` only landed in 20.18.)
      const target = URL.canParse(path) ? new URL(path) : undefined;
      if (target) {
        // WHATWG parsing already lowercased the authority and stripped a
        // default port; `target.host` excludes any userinfo.
        const targetHost = target.host;
        // An authority-less target (e.g. `file:///x`, only reachable via
        // `toNodeHandler`) falls back to the validated `Host`-derived host.
        const targetPath = target.pathname;
        super({
          protocol,
          host: targetHost ? (HOST_RE.test(targetHost) ? targetHost : "_invalid_") : host,
          pathname: targetPath ? (targetPath[0] === "/" ? targetPath : `/${targetPath}`) : "/",
          search: target.search,
        });
      } else {
        // Unparseable target (`serve()` already answers 400 for these; only
        // reachable via `toNodeHandler`, which has no target gate).
        super({ protocol, host, pathname: "/", search: "" });
      }
    }
  }
}

/**
 * Whether `target` is an absolute-form request-target (RFC 9112 §3.2.2) that srvx
 * can serve as an origin server: parseable as a Fetch URL, http(s), and carrying
 * an authority.
 *
 * llhttp delivers any hierarchical `scheme://…` target (`file://`, `ftp://`,
 * `zzz://`), so schemes srvx does not serve are answered with 400 per RFC 9110
 * §7.4 instead of being silently normalized into an http(s) URL.
 */
export function isValidAbsoluteForm(target: string): boolean {
  if (!URL.canParse(target)) {
    return false;
  }
  const url = new URL(target);
  return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
}
