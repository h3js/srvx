import type { BunFetchHandler, Server, ServerOptions } from "../types.ts";
import type * as bun from "bun";
import { resolvePort, resolveTLSOptions } from "../_utils.ts";
import { wrapFetch } from "../_plugin.ts";

export const Response = globalThis.Response;

export function serve(options: ServerOptions): BunServer {
  return new BunServer(options);
}

// https://bun.sh/docs/api/http

class BunServer implements Server<BunFetchHandler> {
  readonly runtime = "bun";
  readonly options: ServerOptions;
  readonly bun: Server["bun"] = {};
  readonly serveOptions: bun.ServeOptions | bun.TLSServeOptions;
  readonly fetch: BunFetchHandler;

  constructor(options: ServerOptions) {
    this.options = options;

    const fetchHandler = wrapFetch(this, this.options.fetch);

    this.fetch = (request, server) => {
      Object.defineProperties(request, {
        runtime: {
          enumerable: true,
          value: { runtime: "bun", bun: { server } },
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
      hostname: this.options.hostname,
      reusePort: this.options.reusePort,
      port: resolvePort(this.options.port, globalThis.process?.env.PORT),
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

  serve() {
    if (!this.bun!.server) {
      this.bun!.server = Bun.serve(this.serveOptions);
    }
    return Promise.resolve(this);
  }

  get url() {
    return this.bun?.server?.url.href;
  }

  ready() {
    return Promise.resolve(this);
  }

  close(closeAll?: boolean) {
    return Promise.resolve(this.bun?.server?.stop(closeAll));
  }
}
