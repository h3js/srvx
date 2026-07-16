import type { CloudflareFetchHandler, Server, ServerOptions } from "../types.ts";
import type * as CF from "@cloudflare/workers-types";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

export function serve(options: ServerOptions): Server<CF.ExportedHandlerFetchHandler> {
  return new CloudflareServer(options);
}

/**
 * Cloudflare Workers server adapter.
 *
 * The recommended entrypoint is the **module-worker** syntax: export the
 * server (or its `.fetch` handler) as the module default so the runtime invokes
 * `fetch(request, env, context)` directly. Only then are `env` bindings (KV, D1,
 * Durable Objects, secrets, ...) available on `request.runtime.cloudflare.env`.
 *
 * For legacy **service-worker** syntax, `serve()` also registers a global
 * `fetch` event listener. In that mode Cloudflare exposes bindings as globals
 * rather than through the event, so `env` is unavailable and
 * `request.runtime.cloudflare.env` is an empty object.
 */
class CloudflareServer implements Server<CloudflareFetchHandler> {
  readonly runtime = "cloudflare";
  readonly options: Server["options"];
  readonly serveOptions: CF.ExportedHandler;
  readonly fetch: CF.ExportedHandlerFetchHandler;

  // Retained so `close()` can remove exactly the listener `serve()` added and
  // repeated `serve()` calls do not stack duplicate listeners (which would
  // trigger a double `respondWith()` error on Cloudflare).
  #fetchListener?: (event: FetchEvent) => void;

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
        ip: {
          enumerable: true,
          // `configurable` so `trustProxy` can override it, matching the
          // bun/deno adapters.
          configurable: true,
          get() {
            return request.headers.get("cf-connecting-ip");
          },
        },
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
    // Service-worker syntax only. Guard against double-registration: calling
    // `serve()` twice (or `manual: true` then `serve()`) must not stack a
    // second listener, otherwise both would call `respondWith()` on the same
    // event and Cloudflare throws.
    if (this.#fetchListener) {
      return;
    }
    this.#fetchListener = (event) => {
      // Service-worker events carry no `env`; bindings are only reachable in
      // module-worker syntax (see the class doc comment).
      // @ts-expect-error `respondWith` is FetchEvent-only.
      event.respondWith(this.fetch(event.request, (event as any).env || {}, event));
    };
    addEventListener("fetch", this.#fetchListener as EventListener);
  }

  ready(): Promise<Server<CF.ExportedHandlerFetchHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    if (this.#fetchListener) {
      removeEventListener("fetch", this.#fetchListener as EventListener);
      this.#fetchListener = undefined;
    }
    return Promise.resolve();
  }
}
