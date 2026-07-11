import type * as TLS from "node:tls";
import { resolveCertOrKey } from "./_utils.ts";
import type { ServerPlugin } from "./types.ts";

/**
 * TLS connection state for the current request.
 *
 * Available when the request was served over TLS. The peer certificate fields are populated only when the server requested a client certificate (`tls.requestCert`) and the client presented one.
 *
 * @note Available only on srvx's Node.js adapter — on Node.js, or on Deno (2.8+) via `node:https`. It is **not** available on Bun: neither native `Bun.serve` nor Bun's `node:http(s)` server exposes the peer certificate to the handler (they enforce `requestCert` / `rejectUnauthorized` at the handshake, but drop the certificate), so unlike Deno the `srvx/node` adapter is not a workaround. Verified against the real Bun runtime (Bun 1.3.14); `bun vitest` without the `--bun` flag silently falls back to Node, which can mask this. See https://github.com/oven-sh/bun/issues/16254
 */
export interface ServerRequestTLS {
  /**
   * The client (peer) certificate, if one was requested and presented.
   *
   * Empty object (`{}`) if the peer did not provide a certificate.
   */
  peerCertificate?: TLS.PeerCertificate;

  /**
   * `true` if the peer certificate was signed by one of the trusted CAs.
   */
  authorized?: boolean;

  /**
   * The reason the peer certificate failed verification, if any.
   */
  authorizationError?: Error | string;

  /**
   * The negotiated TLS protocol version, e.g. `"TLSv1.3"`.
   */
  protocol?: string | null;

  /**
   * The negotiated cipher suite.
   */
  cipher?: TLS.CipherNameAndProtocol;
}

// Opting into the plugin augments `request.tls` onto the request. Consumers that
// don't import `srvx/mtls` don't get the field — keeping it truly opt-in.
//
// `"srvx"` is the public specifier consumers resolve `ServerRequest` through, so the
// augmentation must target it. `"./types.ts"` mirrors it for srvx's own internal
// type-check, where `ServerRequest` is reached through the relative source module.
declare module "srvx" {
  interface ServerRequest {
    /**
     * TLS connection state, including the client (peer) certificate for mutual TLS.
     *
     * Populated by the {@link mtls} plugin. `undefined` when the request was not served over TLS.
     */
    tls?: ServerRequestTLS | undefined;
  }
}
declare module "./types.ts" {
  interface ServerRequest {
    tls?: ServerRequestTLS | undefined;
  }
}

/**
 * Options for the {@link mtls} plugin.
 */
export interface MTLSOptions {
  /**
   * File path(s) or inlined CA certificate(s) in PEM format used to verify client certificates.
   *
   * When set, the well-known Mozilla CAs are replaced by the provided ones.
   */
  ca?: string | string[];

  /**
   * Request a certificate from connecting clients.
   *
   * @default true
   */
  requestCert?: boolean;

  /**
   * Reject the TLS handshake itself when the client certificate is not signed by one of
   * the trusted `ca` certificates — the connection never reaches the `fetch` handler, so
   * checking `request.tls.authorized` in application code is unreachable at this setting.
   *
   * Set to `false` to let the handshake complete regardless and instead expose the
   * unverified certificate via `request.tls` with `authorized: false`, so your handler
   * can decide how to respond.
   *
   * @default true (Node.js default when `requestCert` is enabled)
   */
  rejectUnauthorized?: boolean;
}

/**
 * Mutual TLS (mTLS) plugin for the Node.js adapter.
 *
 * Requests a client certificate during the TLS handshake and exposes it — together
 * with the negotiated protocol and cipher — on {@link ServerRequestTLS | `request.tls`}.
 *
 * Only srvx's Node.js adapter can deliver this (`import { serve } from "srvx/node"`),
 * on Node.js or Deno (via `node:https`). Native `Deno.serve` / `Bun.serve` and Bun's
 * `node:http(s)` server do not expose the peer certificate, so the plugin throws there
 * rather than silently doing nothing. It also requires the server to be configured for
 * TLS (`tls.cert` / `tls.key`) and throws otherwise, since mutual TLS cannot run over
 * plain HTTP.
 *
 * With the default `rejectUnauthorized: true`, unauthenticated clients are rejected
 * during the TLS handshake and never reach the `fetch` handler. Set it to `false` to
 * let every handshake complete and enforce authorization yourself via
 * `request.tls.authorized`, as in the example below.
 *
 * @example
 * ```js
 * import { serve } from "srvx/node";
 * import { mtls } from "srvx/mtls";
 *
 * serve({
 *   tls: { cert, key },
 *   plugins: [mtls({ ca, requestCert: true, rejectUnauthorized: false })],
 *   fetch: (request) => {
 *     if (!request.tls?.authorized) {
 *       return new Response("client certificate required", { status: 401 });
 *     }
 *     return new Response(`Hello, ${request.tls.peerCertificate?.subject?.CN}`);
 *   },
 * });
 * ```
 */
export function mtls(options: MTLSOptions = {}): ServerPlugin {
  return (server) => {
    // Only the Node.js adapter exposes the peer certificate. Fail loudly on anything
    // else instead of silently leaving `request.tls` empty in production.
    if (server.runtime !== "node") {
      throw new Error(
        `[srvx] mtls() requires srvx's Node.js adapter (import { serve } from "srvx/node"). The "${server.runtime}" server cannot request or expose client certificates.`,
      );
    }
    if ("Bun" in globalThis) {
      throw new Error(
        "[srvx] mtls() is not available on Bun: Bun does not expose the peer certificate to node:http(s) request handlers. See https://github.com/oven-sh/bun/issues/16254",
      );
    }
    // Mutual TLS is meaningless without TLS.
    if (
      server.options.protocol === "http" ||
      !server.options.tls?.cert ||
      !server.options.tls?.key
    ) {
      throw new Error(
        "[srvx] mtls() requires an HTTPS server: set `tls.cert` and `tls.key`. Mutual TLS cannot run over plain HTTP.",
      );
    }

    // Resolve + validate `ca` (file paths / inline PEM).
    let ca: string[] | undefined;
    if (options.ca !== undefined) {
      const entries = Array.isArray(options.ca) ? options.ca : [options.ca];
      ca = entries.map((entry) => {
        const resolved = resolveCertOrKey(entry);
        if (!resolved) {
          throw new TypeError("mtls() `ca` entries must be non-empty PEM strings or file paths.");
        }
        return resolved;
      });
    }

    // Forward the mutual-TLS options to the underlying node https/http2 server.
    server.options.node = {
      ...server.options.node,
      ...(ca ? { ca } : {}),
      requestCert: options.requestCert ?? true,
      ...(options.rejectUnauthorized === undefined
        ? {}
        : { rejectUnauthorized: options.rejectUnauthorized }),
    } as typeof server.options.node;

    // Expose the peer certificate on each request from the raw TLS socket.
    server.options.middleware.unshift((request, next) => {
      const socket = request.runtime?.node?.req?.socket as TLS.TLSSocket | undefined;
      // Plain (non-TLS) sockets have no `getPeerCertificate`.
      if (socket && typeof socket.getPeerCertificate === "function") {
        request.tls = {
          peerCertificate: socket.getPeerCertificate(),
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ?? undefined,
          protocol: socket.getProtocol?.() ?? undefined,
          cipher: socket.getCipher?.(),
        };
      }
      return next();
    });
  };
}
