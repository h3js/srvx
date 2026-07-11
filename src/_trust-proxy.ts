/**
 * Controls whether `X-Forwarded-*` headers (proto, and the HTTP/2 `:scheme`
 * pseudo-header) are trusted when deriving request metadata.
 *
 * These headers are set by the client on the wire, so they can only be trusted
 * when a proxy you control sits in front and overwrites them. See
 * {@link ServerOptions.trustProxy}.
 *
 *   - `false` (default): never trust forwarded headers; derive protocol from the
 *     real transport only.
 *   - `true`: always trust forwarded headers.
 *   - `string[]`: trust only when the immediate peer address is in the allowlist.
 *   - `(req) => boolean`: trust only when the predicate returns `true` for the
 *     runtime-native request/event.
 */
export type TrustProxyOption = boolean | string[] | ((req: any) => boolean);

/**
 * Resolve whether forwarded headers should be trusted for a given request.
 *
 * @param trustProxy - The configured {@link TrustProxyOption} (or `undefined`).
 * @param remoteAddress - Address of the immediate peer (for the allowlist form).
 * @param req - Runtime-native request/event passed to the predicate form.
 */
export function isTrustedProxy(
  trustProxy: TrustProxyOption | undefined,
  remoteAddress: string | undefined,
  req: unknown,
): boolean {
  if (trustProxy === undefined || trustProxy === false) {
    return false;
  }
  if (trustProxy === true) {
    return true;
  }
  if (typeof trustProxy === "function") {
    return trustProxy(req) === true;
  }
  // Allowlist of trusted immediate-peer addresses.
  return remoteAddress !== undefined && trustProxy.includes(remoteAddress);
}
