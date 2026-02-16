import type { BunFetchHandler, Server, ServerHandler, ServerOptions } from "../types.ts";
import type * as bun from "bun";
import {
  fmtURL,
  printListening,
  resolvePortAndHost,
  resolveTLSOptions,
  createWaitUntil,
} from "../_utils.ts";
import { wrapFetch } from "../_middleware.ts";
import { gracefulShutdownPlugin } from "../_plugins.ts";

export { FastURL } from "../_url.ts";
export const FastResponse: typeof globalThis.Response = Response;

export function serve(options: ServerOptions): BunServer {
  return new BunServer(options);
}

// https://bun.sh/docs/api/http

class BunServer implements Server<BunFetchHandler> {
  readonly runtime = "bun";
  readonly options: Server["options"];
  readonly bun: Server["bun"] = {};
  readonly serveOptions: bun.Serve.Options<any> | undefined;
  readonly fetch: BunFetchHandler;
  readonly waitUntil?: Server["waitUntil"];

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
    this.waitUntil = this.#wait.waitUntil;

    this.fetch = (request, server) => {
      Object.defineProperties(request, {
        waitUntil: { value: this.#wait?.waitUntil },
        runtime: {
          enumerable: true,
          value: { name: "bun", bun: { server } },
        },
        ip: {
          enumerable: true,
          get() {
            return server?.requestIP(request as Request)?.address;
          },
        },
      });
      return fetchHandler(request);
    };

    const tls = resolveTLSOptions(this.options);
    this.serveOptions = {
      ...resolvePortAndHost(this.options),
      reusePort: this.options.reusePort,
      error: this.options.error,
      ...(this.options.bun as any),
      tls: {
        cert: tls?.cert,
        key: tls?.key,
        passphrase: tls?.passphrase,
        ...(this.options.bun as bun.Serve.Options<any>)?.tls,
      },
      fetch: this.fetch,
    };

    if (!options.manual) {
      this.serve();
    }
  }

  serve(): Promise<this> {
    if (!this.bun!.server) {
      this.bun!.server = Bun.serve(this.serveOptions!);
    }
    printListening(this.options, this.url);
    return Promise.resolve(this);
  }

  get url(): string | undefined {
    const server = this.bun?.server;
    if (!server) {
      return;
    }
    // Prefer address since server.url hostname is not reliable
    const address = (server as { address?: { address: string; family: string; port: number } })
      .address;
    if (address) {
      return fmtURL(address.address, address.port, (server as any).protocol === "https");
    }
    return server.url.href;
  }

  ready(): Promise<this> {
    return Promise.resolve(this);
  }

  async close(closeAll?: boolean): Promise<void> {
    await Promise.all([this.#wait?.wait(), Promise.resolve(this.bun?.server?.stop(closeAll))]);
  }
}
