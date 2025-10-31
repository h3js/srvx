// *** This file should be only imported in the runtime adapters with Node.js compatibility. ***

import type { ServerOptions } from "./types.ts";

export function resolvePortAndHost(opts: ServerOptions): {
  port: number;
  hostname: string | undefined;
} {
  const _port = opts.port ?? globalThis.process?.env.PORT ?? 3000;
  const port = typeof _port === "number" ? _port : Number.parseInt(_port, 10);

  const isBun = !!process.versions.bun;
  const isDeno = !!process.versions.deno;
  const isNode = !isBun && !isDeno;

  if (isNode && (port < 0 || port > 65_535)) {
    throw new RangeError("Port range is between 0 to 65535");
  }

  const hostname = opts.hostname ?? globalThis.process?.env.HOST;
  return { port, hostname };
}

export function fmtURL(
  host: string | undefined,
  port: number | undefined,
  secure: boolean,
): string | undefined {
  if (!host || !port) {
    return undefined;
  }
  if (host.includes(":")) {
    host = `[${host}]`;
  }
  return `http${secure ? "s" : ""}://${host}:${port}/`;
}

export function printListening(
  opts: ServerOptions,
  url: string | undefined,
): void {
  if (!url || (opts.silent ?? globalThis.process?.env?.TEST)) {
    return;
  }

  const _url = new URL(url);
  const allInterfaces = _url.hostname === "[::]" || _url.hostname === "0.0.0.0";
  if (allInterfaces) {
    _url.hostname = "localhost";
    url = _url.href;
  }

  let listeningOn = `➜ Listening on:`;
  let additionalInfo = allInterfaces ? " (all interfaces)" : "";

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
      throw new TypeError(
        "TLS `cert` and `key` must be provided for `https` protocol.",
      );
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
    throw new TypeError(
      "TLS certificate and key must be strings in PEM format or file paths.",
    );
  }
  if (value.startsWith("-----BEGIN ")) {
    return value;
  }
  const { readFileSync } = process.getBuiltinModule("node:fs");
  return readFileSync(value, "utf8");
}

export function createWaitUntil() {
  const promises = new Set<Promise<any>>();
  return {
    waitUntil: (promise: Promise<any>): void => {
      promises.add(
        promise.catch(console.error).finally(() => {
          promises.delete(promise);
        }),
      );
    },
    wait: (): Promise<any> => {
      return Promise.all(promises);
    },
  };
}
