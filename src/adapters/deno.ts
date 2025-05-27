import type { DenoFetchHandler, Server, ServerOptions } from "../types.ts";
import {
  fmtURL,
  printListening,
  resolvePortAndHost,
  resolveTLSOptions,
} from "../_utils.node.ts";
import { wrapFetch } from "../_middleware.ts";

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
    | (Deno.ServeTcpOptions & Deno.TlsCertifiedKeyPem);
  readonly fetch: DenoFetchHandler;

  #listeningPromise?: Promise<void>;
  #listeningInfo?: { hostname: string; port: number };

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);

    const fetchHandler = wrapFetch(this);

    this.fetch = (request, info) => {
      Object.defineProperties(request, {
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
      ...(tls
        ? { key: tls.key, cert: tls.cert, passphrase: tls.passphrase }
        : {}),
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

  close(): Promise<void | undefined> {
    // TODO: closeAll is not supported
    return Promise.resolve(this.deno?.server?.shutdown());
  }
}
