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
