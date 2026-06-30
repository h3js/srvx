// *** This file should be only imported in the runtime adapters with Node.js compatibility. ***

import type { ServerOptions } from "./types.ts";

export function resolvePortAndHost(opts: ServerOptions): {
  port: number;
  hostname: string | undefined;
} {
  const _port = opts.port ?? globalThis.process?.env.PORT ?? 3000;
  const port = typeof _port === "number" ? _port : Number.parseInt(_port, 10);
  if (port < 0 || port > 65_535) {
    throw new RangeError(`Port must be between 0 and 65535 (got "${port}").`);
  }

  const hostname = opts.hostname ?? globalThis.process?.env.HOST;
  return { port, hostname };
}

export function fmtURL(
  host: string | undefined,
  port: number | undefined,
  secure: boolean | undefined,
): string | undefined {
  if (!host || !port) {
    return undefined;
  }
  if (host.includes(":")) {
    host = `[${host}]`;
  }
  return `http${secure ? "s" : ""}://${host}:${port}/`;
}

export function printListening(opts: ServerOptions, url: string | undefined): void {
  if (!url || (opts.silent ?? globalThis.process?.env?.TEST)) {
    return;
  }

  let additionalInfo = "";
  try {
    const _url = new URL(url);
    const allInterfaces = _url.hostname === "[::]" || _url.hostname === "0.0.0.0";
    if (allInterfaces) {
      _url.hostname = "localhost";
      url = _url.href;
      additionalInfo = " (all interfaces)";
    }
  } catch {
    // URL is not parsable (e.g., unix socket), use as-is
  }

  let listeningOn = `➜ Listening on:`;

  if (globalThis.process.stdout?.isTTY) {
    listeningOn = `\u001B[32m${listeningOn}\u001B[0m`; // ANSI green
    url = `\u001B[36m${url}\u001B[0m`; // ANSI cyan
    additionalInfo = `\u001B[2m${additionalInfo}\u001B[0m`; // ANSI dim
  }

  console.log(`${listeningOn} ${url}${additionalInfo}`);
}

export function resolveTLSOptions(opts: ServerOptions):
  | {
      cert: string;
      key: string;
      passphrase: any;
    }
  | undefined {
  if (!opts.tls || opts.protocol === "http") {
    return;
  }
  const cert = resolveCertOrKey(opts.tls.cert);
  const key = resolveCertOrKey(opts.tls.key);
  if (!cert && !key) {
    if (opts.protocol === "https") {
      throw new TypeError("TLS `cert` and `key` must be provided for `https` protocol.");
    }
    return;
  }
  if (!cert || !key) {
    throw new TypeError("TLS `cert` and `key` must be provided together.");
  }
  return {
    cert,
    key,
    passphrase: opts.tls.passphrase,
  };
}

function resolveCertOrKey(value?: unknown): undefined | string {
  if (!value) {
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError("TLS certificate and key must be strings in PEM format or file paths.");
  }
  if (value.startsWith("-----BEGIN ")) {
    return value;
  }
  const { readFileSync } = process.getBuiltinModule("node:fs");
  return readFileSync(value, "utf8");
}

/**
 * Normalize srvx's node-adapter `NodeResponse` back to a native `Response`.
 *
 * Web-native serve()s (Bun, Deno, ...) strictly require a real `Response`. A
 * `NodeResponse` (the node adapter's `FastResponse`) can reach them whenever the
 * code constructing the response resolves srvx's `node` export condition while
 * the host serves via the bun/deno adapter (e.g. Vite module-runner / Nitro
 * under `bun --bun`). `NodeResponse` exposes a lazy `_response` getter that
 * builds the native `Response`, so the unwrap is cheap.
 *
 * Kept allocation-free on the hot path: native responses (no `_toNodeResponse`)
 * are returned as-is, and a sync handler result is not forced into a microtask.
 */
export function toNativeResponse(res: Response | Promise<Response>): Response | Promise<Response> {
  // Detect via the `_toNodeResponse` brand (a plain method, the same
  // discriminator used in `_node/send.ts`), then unwrap via the `_response`
  // getter. Triggering `_response` is intentional here: for a NodeResponse we
  // want the (memoized) native Response built. A native Response has no
  // `_response`, so the common path never touches the getter.
  if ((res as NodeResponseLike)?._toNodeResponse) {
    return (res as NodeResponseLike)._response!;
  }
  if (typeof (res as Promise<Response>)?.then === "function") {
    return (res as Promise<Response>).then(toNativeResponse) as Promise<Response>;
  }
  return res;
}

interface NodeResponseLike {
  _toNodeResponse?: () => unknown;
  _response?: Response;
}

export function createWaitUntil() {
  const promises = new Set<Promise<any> | PromiseLike<any>>();
  return {
    waitUntil: (promise: Promise<any> | PromiseLike<any>): void => {
      if (typeof promise?.then !== "function") return;
      promises.add(
        Promise.resolve(promise)
          .catch(console.error)
          .finally(() => {
            promises.delete(promise);
          }),
      );
    },
    wait: (): Promise<any> => {
      return Promise.all(promises);
    },
  };
}
