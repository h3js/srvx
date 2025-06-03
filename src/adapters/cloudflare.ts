import type {
  CloudflareFetchHandler,
  Server,
  ServerOptions,
} from "../types.ts";
import type * as CF from "@cloudflare/workers-types";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

export function serve(
  options: ServerOptions,
): Server<CF.ExportedHandlerFetchHandler> {
  return new CloudflareServer(options);
}

class CloudflareServer implements Server<CloudflareFetchHandler> {
  readonly runtime = "cloudflare";
  readonly options: Server["options"];
  readonly serveOptions: CF.ExportedHandler;
  readonly fetch: CF.ExportedHandlerFetchHandler;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this as any as Server);
    errorPlugin(this as unknown as Server);

    const fetchHandler = wrapFetch(this as unknown as Server);

    this.fetch = (request, env, context) => {
      Object.defineProperties(request, {
        waitUntil: { value: context.waitUntil.bind(context) },
        runtime: {
          enumerable: true,
          value: { name: "cloudflare", cloudflare: { env, context } },
        },
        // TODO
        // ip: {
        //   enumerable: true,
        //   get() {
        //     return;
        //   },
        // },
      });
      return fetchHandler(request as unknown as Request) as unknown as
        | CF.Response
        | Promise<CF.Response>;
    };

    this.serveOptions = {
      fetch: this.fetch,
    };

    if (!options.manual) {
      this.serve();
    }
  }

  serve() {
    addEventListener("fetch", (event) => {
      // @ts-expect-error
      event.respondWith(this.fetch(event.request, {}, event));
    });
  }

  ready(): Promise<Server<CF.ExportedHandlerFetchHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    return Promise.resolve();
  }
}
