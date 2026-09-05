import type { ServerPlugin, ServerRequest } from "./types.ts";

/**
 * Controls whether `X-Forwarded-*` headers (proto, host, for, and the HTTP/2
 * `:scheme` pseudo-header) are trusted when deriving request metadata.
 *
 * These headers are appended by every proxy on the wire, so trusting them is
 * hop-aware: starting from the immediate peer and walking the forwarded chain
 * right-to-left, each address in the trusted set is treated as a proxy we
 * control. The first address *not* in the set is the real client (see
 * {@link ServerOptions.trustProxy}).
 *
 *   - `false` (default): never trust forwarded headers; derive protocol, host
 *     and client IP from the real transport only.
 *   - `true`: always trust forwarded headers (every hop is trusted, so the
 *     leftmost `X-Forwarded-For` entry is the client).
 *   - `"loopback"`: trust only hops on a loopback address (`127.0.0.0/8` or
 *     `::1`), i.e. a proxy running on the same host.
 *   - `string[]`: trust only hops whose address is in the allowlist.
 */
export type TrustProxyOption = boolean | "loopback" | string[];

/**
 * Resolve whether forwarded headers should be trusted for a given request.
 *
 * @param trustProxy - The configured {@link TrustProxyOption} (or `undefined`).
 * @param remoteAddress - Address of the immediate peer.
 */
export function isTrustedProxy(
  trustProxy: TrustProxyOption | undefined,
  remoteAddress: string | undefined,
): boolean {
  if (trustProxy === undefined || trustProxy === false) {
    return false;
  }
  if (trustProxy === true) {
    return true;
  }
  if (trustProxy === "loopback") {
    return isLoopbackAddress(remoteAddress);
  }
  // Allowlist of trusted immediate-peer addresses. Dual-stack Node reports an
  // IPv4 peer as an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`), so also match
  // the bare IPv4 form against the allowlist.
  if (remoteAddress === undefined) {
    return false;
  }
  if (trustProxy.includes(remoteAddress)) {
    return true;
  }
  const mapped = ipv4FromMapped(remoteAddress);
  return mapped !== undefined && trustProxy.includes(mapped);
}

/** Bare IPv4 form of an IPv4-mapped IPv6 address (`::ffff:1.2.3.4` -> `1.2.3.4`). */
function ipv4FromMapped(address: string): string | undefined {
  return address.startsWith("::ffff:") && address.includes(".")
    ? address.slice("::ffff:".length)
    : undefined;
}

/** Whether `address` is an IPv4/IPv6 loopback address. */
function isLoopbackAddress(address: string | undefined): boolean {
  return (
    !!address &&
    (address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127."))
  );
}

/**
 * Validates an HTTP Host header value (domain, IPv4, or bracketed IPv6) with
 * optional port. Used to reject spoofed/malformed hosts (e.g. `"localhost:3000/foobar?"`
 * or a forwarded host containing whitespace) across every adapter.
 */
export const HOST_RE: RegExp =
  /^(\[(?:[A-Fa-f0-9:.]+)\]|(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+|(?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/;

/** Whether a host value carries an explicit `:port` (handles `[IPv6]:port`). */
function forwardedHostHasPort(host: string): boolean {
  const bracket = host.lastIndexOf("]");
  return bracket === -1 ? host.includes(":") : host.indexOf(":", bracket) !== -1;
}

/**
 * Split a comma-separated `X-Forwarded-*` header value into trimmed, non-empty
 * entries in header order (left to right, i.e. outermost/original client first,
 * nearest proxy last). Node exposes repeated headers as a `string[]`, which is
 * joined before splitting.
 */
export function forwardedList(value: string | string[] | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const raw = Array.isArray(value) ? value.join(",") : value;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Resolve the real client IP hop-aware, per {@link TrustProxyOption}.
 *
 * Conceptually the hop chain (nearest first) is `[peer, ...reversed(forwarded)]`:
 * the socket peer added no entry of its own, and each proxy appended the address
 * it saw. Walking right-to-left, every address in the trusted set is a proxy we
 * control; the first untrusted address is the client. If every hop is trusted
 * the client is the leftmost forwarded entry (matching Express `trust proxy`),
 * falling back to the peer when no `X-Forwarded-For` is present. If the peer
 * itself is untrusted the header is ignored entirely and the peer is the client.
 */
export function resolveClientIP(
  trustProxy: TrustProxyOption | undefined,
  peer: string | undefined,
  forwardedFor: string | string[] | null | undefined,
): string | undefined {
  if (!isTrustedProxy(trustProxy, peer)) {
    return peer;
  }
  const list = forwardedList(forwardedFor);
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(trustProxy, list[i])) {
      return list[i];
    }
  }
  return list.length > 0 ? list[0] : peer;
}

/**
 * Number of trusted hops in front of the server, counting the immediate peer and
 * every trusted `X-Forwarded-For` entry walking right-to-left. `0` means the peer
 * is untrusted, so no forwarded value may be honored. This count also selects the
 * trusted entry of the parallel `X-Forwarded-Proto`/`-Host` lists (see
 * {@link forwardedHopValue}).
 *
 * When the whole visible chain is trusted (the peer and every `X-Forwarded-For`
 * entry — e.g. `trustProxy: true`, or the real client sits upstream of all seen
 * proxies), the number of trusted hops is effectively unbounded, so `Infinity` is
 * returned. A proto/host list may then legitimately be longer than the seen
 * `X-Forwarded-For` chain, and its leftmost (original-client) entry is honored.
 */
export function trustedHops(
  trustProxy: TrustProxyOption | undefined,
  peer: string | undefined,
  forwardedFor: string | string[] | null | undefined,
): number {
  if (!isTrustedProxy(trustProxy, peer)) {
    return 0;
  }
  const list = forwardedList(forwardedFor);
  let hops = 1; // the peer
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(trustProxy, list[i])) {
      return hops;
    }
    hops++;
  }
  // No untrusted boundary found in the visible chain: treat as unbounded.
  return Number.POSITIVE_INFINITY;
}

/**
 * Pick the entry of a forwarded `X-Forwarded-Proto`/`-Host` list contributed by
 * the outermost trusted proxy, given the {@link trustedHops} count. Proxies
 * append these in lockstep with `X-Forwarded-For`, so with `hops` trusted hops we
 * may trust the `hops` rightmost entries; the outermost trusted one is at index
 * `length - hops` (clamped, so it degrades to the leftmost value when every hop
 * is trusted or the list is shorter than the chain). Returns `undefined` when the
 * peer is untrusted (`hops <= 0`) or the list is empty.
 */
export function forwardedHopValue(
  value: string | string[] | null | undefined,
  hops: number,
): string | undefined {
  if (hops <= 0) {
    return undefined;
  }
  const list = forwardedList(value);
  if (list.length === 0) {
    return undefined;
  }
  return list[Math.max(0, list.length - hops)];
}

/**
 * Universal `trustProxy` plugin for runtimes whose native `Request` already
 * reports the real transport (Bun, Deno). When the immediate peer is a trusted
 * proxy, it rewrites `request.url` from `X-Forwarded-Proto` / `X-Forwarded-Host`
 * and `request.ip` from `X-Forwarded-For`.
 *
 * The Node and AWS Lambda adapters resolve these at request construction and do
 * not use this plugin. It is a no-op when `trustProxy` is unset/`false`.
 */
export const trustProxyPlugin: ServerPlugin = (server) => {
  const trustProxy = server.options.trustProxy;
  if (trustProxy === undefined || trustProxy === false) {
    return;
  }
  server.options.middleware.unshift((request, next) => {
    applyTrustedProxy(request, trustProxy);
    return next();
  });
};

function applyTrustedProxy(request: ServerRequest, trustProxy: TrustProxyOption): void {
  // The socket peer address (via the adapter's native getter) is the nearest hop
  // and stays authoritative for the trust decision. `trustedHops` walks the
  // `X-Forwarded-For` chain right-to-left from it; `0` means the peer is
  // untrusted, so every forwarded header is ignored.
  const peer = request.ip;
  const headers = request.headers;
  const hops = trustedHops(trustProxy, peer, headers.get("x-forwarded-for"));
  if (hops === 0) {
    return;
  }

  // request.url <- X-Forwarded-Proto / X-Forwarded-Host (trusted hop entry)
  const forwardedProto = forwardedHopValue(headers.get("x-forwarded-proto"), hops);
  const forwardedHost = forwardedHopValue(headers.get("x-forwarded-host"), hops);
  if (forwardedProto || forwardedHost) {
    const url = new URL(request.url);
    if (forwardedProto === "https" || forwardedProto === "http") {
      url.protocol = `${forwardedProto}:`;
    }
    // Only apply a well-formed forwarded host. Relying on the URL setter to
    // reject invalid values silently keeps the original host but still runs the
    // port-reset below, which would drop the real listener port. Validating up
    // front (same `HOST_RE` as the Node adapter) skips bad values entirely.
    if (forwardedHost && HOST_RE.test(forwardedHost)) {
      url.host = forwardedHost;
      // The `host` setter only updates the port when the value carries one, so
      // an origin-form host (no port) would inherit the listener's port. The
      // forwarded host is authoritative, so drop any leftover port in that case.
      if (url.port && !forwardedHostHasPort(forwardedHost)) {
        url.port = "";
      }
    }
    Object.defineProperty(request, "url", {
      value: url.href,
      enumerable: true,
      configurable: true,
    });
  }

  // request.ip <- X-Forwarded-For (first untrusted address, hop-aware)
  const client = resolveClientIP(trustProxy, peer, headers.get("x-forwarded-for"));
  if (client && client !== peer) {
    Object.defineProperty(request, "ip", {
      value: client,
      enumerable: true,
      configurable: true,
    });
  }
}
