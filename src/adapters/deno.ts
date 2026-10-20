import type { DenoFetchHandler, Server, ServerHandler, ServerOptions } from "../types.ts";
import type { DenoServeOptions } from "../types/deno.ts";
import {
  createWaitUntil,
  fmtURL,
  printListening,
  resolvePortAndHost,
  resolveTLSOptions,
  toNativeResponse,
} from "../_utils.ts";
import { wrapFetch } from "../_middleware.ts";
import { gracefulShutdownPlugin } from "../_plugins.ts";
import { trustProxyPlugin } from "../_trust-proxy.ts";
import { limitRequestBody } from "../body-limit.ts";

export { FastURL } from "../_url.ts";
export const FastResponse: typeof globalThis.Response = Response;

export function serve(options: ServerOptions): DenoServer {
  return new DenoServer(options);
}

// https://docs.deno.com/api/deno/~/Deno.serve

type DenoListenInfo = { hostname: string; port: number; path?: string };

class DenoServer implements Server<DenoFetchHandler> {
  readonly runtime = "deno";
  readonly options: Server["options"];
  readonly deno: Server["deno"] = {};
  readonly serveOptions: DenoServeOptions | undefined;
  readonly fetch: DenoFetchHandler;
  readonly waitUntil?: Server["waitUntil"];

  #listeningPromise?: Promise<void>;
  // Deno passes `{ transport: "unix", path }` instead when listening on a unix socket.
  #listeningInfo?: DenoListenInfo;

  #wait: ReturnType<typeof createWaitUntil> | undefined;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);

    trustProxyPlugin(this);
    gracefulShutdownPlugin(this);

    const fetchHandler = wrapFetch(this);

    // Detect running in srvx loader
    const loader = (globalThis as any).__srvxLoader__ as
      | ((obj: { server: Server }) => void)
      | undefined;
    if (loader) {
      this.fetch = fetchHandler;
      loader({ server: this });
      return;
    }

    this.#wait = createWaitUntil();
    this.waitUntil = this.#wait.waitUntil;

    const maxRequestBodySize = this.options.maxRequestBodySize;
    const isUnix = !!(this.options.deno?.path ?? this.options.unix);
    this.fetch = (request, info) => {
      // On a unix socket Deno builds `http+unix://` request URLs (a non-special
      // scheme, so `origin` is "null"), and without a `Host` header it uses the
      // percent-encoded socket path as the host. Normalize to `http://<host>`
      // (or `localhost`, like Node). Overriding the property instead of
      // rebuilding the request avoids a copy and Deno's `request.signal`
      // legacy-behavior warning.
      if (isUnix && request.url.startsWith("http+unix:")) {
        const url = new URL(request.url);
        const host = request.headers.get("host") ? url.host : "localhost";
        Object.defineProperty(request, "url", {
          enumerable: true,
          // Configurable so the trustProxy plugin can override it.
          configurable: true,
          value: `http://${host}${url.pathname}${url.search}`,
        });
      }
      // Deno.serve has no native body-size option, so enforce it here by
      // rebuilding the request with a size-limited body stream (no-op when unset
      // or bodyless, keeping the default hot path allocation-free).
      if (maxRequestBodySize !== undefined) {
        request = limitRequestBody(request, maxRequestBodySize);
      }
      Object.defineProperties(request, {
        waitUntil: { value: this.#wait?.waitUntil },
        runtime: {
          enumerable: true,
          value: { name: "deno", deno: { info, server: this.deno?.server } },
        },
        ip: {
          enumerable: true,
          // Configurable so the trustProxy plugin can override it from
          // `X-Forwarded-For` when the peer is trusted.
          configurable: true,
          get() {
            return info?.remoteAddr?.hostname;
          },
        },
      });
      // Deno.serve strictly requires a native Response; normalize node-adapter
      // NodeResponse (see toNativeResponse). Cheap no-op for native responses.
      return toNativeResponse(fetchHandler(request));
    };

    const tls = resolveTLSOptions(this.options);
    this.serveOptions = {
      ...(this.options.unix
        ? { path: this.options.unix, transport: "unix" as const }
        : resolvePortAndHost(this.options)),
      reusePort: this.options.reusePort,
      onError: this.options.error,
      ...(tls ? { key: tls.key, cert: tls.cert, passphrase: tls.passphrase } : {}),
      ...this.options.deno,
    };
    // Deno.serve silently ignores `cert`/`key` on a unix socket and serves
    // plaintext; refuse instead of downgrading.
    if (this.serveOptions.path && this.serveOptions.cert) {
      throw new TypeError("TLS is not supported on unix sockets in Deno.");
    }

    if (!options.manual) {
      this.serve();
    }
  }

  serve(): Promise<this> {
    if (this.deno?.server) {
      return Promise.resolve(this.#listeningPromise).then(() => this);
    }
    const onListenPromise = Promise.withResolvers<void>();
    this.#listeningPromise = onListenPromise.promise;
    this.deno!.server = Deno.serve(
      {
        // `DenoServeOptions` is the open shape srvx accepts (see
        // `src/types/README.md`); `Deno.serve` overloads on mutually exclusive
        // tcp/unix variants that no single object type satisfies.
        ...(this.serveOptions as Deno.ServeTcpOptions),
        onListen: (info: DenoListenInfo) => {
          this.#listeningInfo = info;
          if (this.options.deno?.onListen) {
            this.options.deno.onListen(info);
          }
          printListening(this.options, this.url);
          onListenPromise.resolve();
        },
      },
      this.fetch,
    );
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  get url(): string | undefined {
    if (this.#listeningInfo?.path) {
      return this.#listeningInfo.path; // unix socket (same as node)
    }
    return this.#listeningInfo
      ? fmtURL(
          this.#listeningInfo.hostname,
          this.#listeningInfo.port,
          !!(this.serveOptions as { cert: string }).cert,
        )
      : undefined;
  }

  ready(): Promise<Server> {
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  async close(): Promise<void> {
    await Promise.all([this.#wait?.wait(), Promise.resolve(this.deno?.server?.shutdown())]);
  }
}
