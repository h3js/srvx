import type { ServerPlugin, ServerRequest } from "./types.ts";

/**
 * Controls whether `X-Forwarded-*` headers (proto, host, for, and the HTTP/2
 * `:scheme` pseudo-header) are trusted when deriving request metadata.
 *
 * These headers are set by the client on the wire, so they can only be trusted
 * when a proxy you control sits in front and overwrites them. See
 * {@link ServerOptions.trustProxy}.
 *
 *   - `false` (default): never trust forwarded headers; derive protocol, host
 *     and client IP from the real transport only.
 *   - `true`: always trust forwarded headers.
 *   - `"loopback"`: trust only when the immediate peer is a loopback address
 *     (`127.0.0.0/8` or `::1`), i.e. a proxy running on the same host.
 *   - `string[]`: trust only when the immediate peer address is in the allowlist.
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
 * Leftmost/first entry of a comma-separated `X-Forwarded-*` header value. With a
 * chain of proxies the header is a comma-separated list; the leftmost entry is
 * the value seen by the outermost proxy. Node exposes repeated headers as a
 * `string[]`, so the array form is normalized to its first element.
 */
export function firstForwardedValue(
  value: string | string[] | null | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const first = (Array.isArray(value) ? value[0] : value).split(",")[0].trim();
  return first || undefined;
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
  // The socket peer address stays authoritative for the trust decision, so read
  // it (via the adapter's native getter) before any override below.
  if (!isTrustedProxy(trustProxy, request.ip)) {
    return;
  }

  const headers = request.headers;

  // request.url <- X-Forwarded-Proto / X-Forwarded-Host
  const forwardedProto = firstForwardedValue(headers.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(headers.get("x-forwarded-host"));
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

  // request.ip <- X-Forwarded-For (leftmost = original client)
  const forwardedFor = firstForwardedValue(headers.get("x-forwarded-for"));
  if (forwardedFor) {
    Object.defineProperty(request, "ip", {
      value: forwardedFor,
      enumerable: true,
      configurable: true,
    });
  }
}
