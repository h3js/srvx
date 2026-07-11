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
  // Allowlist of trusted immediate-peer addresses.
  return remoteAddress !== undefined && trustProxy.includes(remoteAddress);
}

/** Whether `address` is an IPv4/IPv6 loopback address. */
function isLoopbackAddress(address: string | undefined): boolean {
  return (
    !!address &&
    (address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127."))
  );
}

/** Whether a host value carries an explicit `:port` (handles `[IPv6]:port`). */
function forwardedHostHasPort(host: string): boolean {
  const bracket = host.lastIndexOf("]");
  return bracket === -1 ? host.includes(":") : host.indexOf(":", bracket) !== -1;
}

/** Leftmost/first entry of a comma-separated `X-Forwarded-*` header value. */
function firstForwardedValue(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const first = value.split(",")[0].trim();
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
    if (forwardedHost) {
      // Invalid hosts are ignored by the URL setter, keeping the original host.
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
