import type { DenoFetchHandler, Server, ServerHandler, ServerOptions } from "../types.ts";
import {
  createWaitUntil,
  fmtURL,
  printListening,
  resolvePortAndHost,
  resolveTLSOptions,
} from "../_utils.ts";
import { wrapFetch } from "../_middleware.ts";
import { gracefulShutdownPlugin } from "../_plugins.ts";

export { FastURL } from "../_url.ts";
export const FastResponse: typeof globalThis.Response = Response;

export function serve(options: ServerOptions): DenoServer {
  return new DenoServer(options);
}

// https://docs.deno.com/api/deno/~/Deno.serve

class DenoServer implements Server<DenoFetchHandler> {
  readonly runtime = "deno";
  readonly options: Server["options"];
  readonly deno: Server["deno"] = {};
  readonly serveOptions:
    | Deno.ServeTcpOptions
    | (Deno.ServeTcpOptions & Deno.TlsCertifiedKeyPem)
    | undefined;
  readonly fetch: DenoFetchHandler;

  #listeningPromise?: Promise<void>;
  #listeningInfo?: { hostname: string; port: number };

  #wait: ReturnType<typeof createWaitUntil> | undefined;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);

    gracefulShutdownPlugin(this);

    const fetchHandler = wrapFetch(this);

    // Detect running in srvx loader
    const loader = (globalThis as any).__srvxLoader__ as
      | ((handler: ServerHandler) => void)
      | undefined;
    if (loader) {
      this.fetch = fetchHandler;
      loader(fetchHandler);
      return;
    }

    this.#wait = createWaitUntil();

    this.fetch = (request, info) => {
      Object.defineProperties(request, {
        waitUntil: { value: this.#wait?.waitUntil },
        runtime: {
          enumerable: true,
          value: { name: "deno", deno: { info, server: this.deno?.server } },
        },
        ip: {
          enumerable: true,
          get() {
            return (info?.remoteAddr as Deno.NetAddr)?.hostname;
          },
        },
      });
      return fetchHandler(request);
    };

    const tls = resolveTLSOptions(this.options);
    this.serveOptions = {
      ...resolvePortAndHost(this.options),
      reusePort: this.options.reusePort,
      onError: this.options.error,
      ...(tls ? { key: tls.key, cert: tls.cert, passphrase: tls.passphrase } : {}),
      ...this.options.deno,
    };

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
        ...this.serveOptions,
        onListen: (info) => {
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
