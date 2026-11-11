import type { NodeServerRequest } from "../../types.ts";
import { forwardedHopValue, isValidHost } from "../../_trust-proxy.ts";
import { FastURL } from "../../_url.ts";

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

    let host = forwardedHost && isValidHost(forwardedHost) ? forwardedHost : undefined;
    if (!host) {
      host = req.headers.host || (req.headers[":authority"] as string);
      if (host && !isValidHost(host)) {
        host = "_invalid_";
      }
    }
    if (!host) {
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
      // on TLS), the request-line authority is `isValidHost`-validated exactly like
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
          host: targetHost ? (isValidHost(targetHost) ? targetHost : "_invalid_") : host,
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
 * Whether the path of a request-target (before its first `?`) contains a raw `\`
 * or a complete `.` / `..` segment, in any spelling (`%2e`, `%2E`, `.%2e`, ...).
 *
 * WHATWG URL parsing rewrites both for http(s) URLs: `\` becomes a path separator
 * and dot segments are resolved (`%2e` counts as a dot). llhttp and nghttp2 deliver
 * them verbatim, so `/public/../admin/secret` (or `/public\..\admin/secret`) would
 * reach the fetch handler as `/admin/secret` while the raw `req.url`, seen by Node
 * middleware, still routes under `/public`. `serve()` and `toNodeHandler()` answer
 * 400 instead, so one request has one path in every layer. Browsers, `fetch()` and
 * curl resolve dot segments before sending (RFC 3986 §5.2.4), and a raw `\` is not
 * valid in a request-target (RFC 3986 §3.3), so normal clients never hit this.
 *
 * Left alone: dots inside a segment (`/.well-known`, `/a/...`, `/a/..b`, `/a.b`),
 * a percent-encoded `%5C`, and anything in the query. The dot-segment definition
 * matches `FastURL`'s origin-form check (`_originFormNeedsNormRE` in `src/_url.ts`);
 * a segment also ends at `#`. Only `?` ends the path here, so a `\` or dot segment
 * after a `#` (itself invalid in a request-target) but before any `?` is rejected.
 *
 * Hot path: three single-char `indexOf` scans (`\`, `.`, `%`); a target with none
 * of them returns right away. A `.` / `%` found is checked in place, and since a
 * dot segment must follow a `/`, the next candidate is only searched for after
 * the next `/`. These scans run over the whole target, query included, and `?`
 * is looked up only after a match, to tell path from query. This is intentional:
 * the scan stays linear, and an upfront `?` lookup (or a regex, a char loop or a
 * two-char `indexOf`) measured slower on common paths.
 */
export function hasAmbiguousPath(target: string): boolean {
  const backslash = target.indexOf("\\");
  let dot = target.indexOf(".");
  let percent = target.indexOf("%");
  if (backslash === -1 && dot === -1 && percent === -1) {
    return false;
  }
  // Earliest offending index anywhere in the target (`length` = none).
  let first = backslash === -1 ? target.length : backslash;
  while (dot !== -1 && dot < first && !_isDotSegmentAt(target, dot)) {
    dot = _nextAfterSlash(target, dot, ".");
  }
  if (dot !== -1 && dot < first) {
    first = dot;
  }
  while (percent !== -1 && percent < first && !_isDotSegmentAt(target, percent)) {
    percent = _nextAfterSlash(target, percent, "%");
  }
  if (percent !== -1 && percent < first) {
    first = percent;
  }
  if (first === target.length) {
    return false;
  }
  const queryIndex = target.indexOf("?");
  return queryIndex === -1 || first < queryIndex;
}

// Next `char` after the first `/` past `i` (`-1` if none).
function _nextAfterSlash(target: string, i: number, char: string): number {
  const slash = target.indexOf("/", i + 1);
  return slash === -1 ? -1 : target.indexOf(char, slash + 1);
}

// Whether a `/`-preceded segment starting at `i` is exactly one or two dots
// (`.` or `%2e`/`%2E` each), ended by `/`, `?`, `#` or the end of `target`.
function _isDotSegmentAt(target: string, i: number): boolean {
  if (target.charCodeAt(i - 1) !== 47 /* / */) {
    return false;
  }
  let dots = 0;
  for (;;) {
    const c = target.charCodeAt(i);
    if (c === 46 /* . */) {
      i += 1;
    } else if (
      c === 37 /* % */ &&
      target.charCodeAt(i + 1) === 50 /* 2 */ &&
      (target.charCodeAt(i + 2) | 0x20) === 101 /* e or E */
    ) {
      i += 3;
    } else {
      break;
    }
    if (++dots > 2) {
      return false;
    }
  }
  if (dots === 0) {
    return false;
  }
  if (i >= target.length) {
    return true;
  }
  // `/`, `?` or `#`
  const c = target.charCodeAt(i);
  return c === 47 || c === 63 || c === 35;
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
