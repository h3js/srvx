import type { BunFetchHandler, Server, ServerOptions } from "../types.ts";
import type * as bun from "bun";
import {
  fmtURL,
  printListening,
  resolvePortAndHost,
  resolveTLSOptions,
} from "../_utils.node.ts";
import { wrapFetch } from "../_middleware.ts";

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
  readonly serveOptions: bun.ServeOptions | bun.TLSServeOptions;
  readonly fetch: BunFetchHandler;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);

    const fetchHandler = wrapFetch(this);

    this.fetch = (request, server) => {
      Object.defineProperties(request, {
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
      ...this.options.bun,
      tls: {
        cert: tls?.cert,
        key: tls?.key,
        passphrase: tls?.passphrase,
        ...(this.options.bun as bun.TLSServeOptions)?.tls,
      },
      fetch: this.fetch,
    };

    if (!options.manual) {
      this.serve();
    }
  }

  serve(): Promise<this> {
    if (!this.bun!.server) {
      this.bun!.server = Bun.serve(this.serveOptions);
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
    const address = (
      server as { address?: { address: string; family: string; port: number } }
    ).address;
    if (address) {
      return fmtURL(
        address.address,
        address.port,
        (server as any).protocol === "https",
      );
    }
    return server.url.href;
  }

  ready(): Promise<this> {
    return Promise.resolve(this);
  }

  close(closeAll?: boolean): Promise<void> {
    return Promise.resolve(this.bun?.server?.stop(closeAll));
  }
}
