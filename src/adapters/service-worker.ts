/* eslint-disable unicorn/prefer-global-this */
import type { Server, ServerOptions, ServerRequest } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

export type ServiceWorkerHandler = (
  request: ServerRequest,
  event: FetchEvent,
) => Response | Promise<Response>;

const isBrowserWindow =
  typeof window !== "undefined" && typeof navigator !== "undefined";

const isServiceWorker = typeof self !== "undefined" && "skipWaiting" in self;

export function serve(options: ServerOptions): Server<ServiceWorkerHandler> {
  return new ServiceWorkerServer(options);
}

class ServiceWorkerServer implements Server<ServiceWorkerHandler> {
  readonly runtime = "service-worker";
  readonly options: Server["options"];
  readonly fetch: ServiceWorkerHandler;

  #fetchListener?: (event: FetchEvent) => void | Promise<void>;
  #listeningPromise?: Promise<any>;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this as any as Server);
    errorPlugin(this as unknown as Server);

    const fetchHandler = wrapFetch(this as unknown as Server);

    this.fetch = (request: Request, event: FetchEvent) => {
      Object.defineProperties(request, {
        runtime: {
          enumerable: true,
          value: { name: "service-worker", serviceWorker: { event } },
        },
      });
      return Promise.resolve(fetchHandler(request));
    };

    if (!options.manual) {
      this.serve();
    }
  }

  serve() {
    if (isBrowserWindow) {
      if (!navigator.serviceWorker) {
        throw new Error(
          "Service worker is not supported in the current window.",
        );
      }
      const swURL = this.options.serviceWorker?.url;
      if (!swURL) {
        throw new Error(
          "Service worker URL is not provided. Please set the `serviceWorker.url` serve option or manually register.",
        );
      }
      // Self-register the service worker
      this.#listeningPromise = navigator.serviceWorker
        .register(swURL, {
          type: "module",
          scope: this.options.serviceWorker?.scope,
        })
        .then((registration) => {
          if (registration.active) {
            location.replace(location.href);
          } else {
            registration.addEventListener("updatefound", () => {
              location.replace(location.href);
            });
          }
        });
    } else if (isServiceWorker) {
      // Listen for the 'fetch' event to handle requests
      this.#fetchListener = async (event) => {
        // skip if event url ends with file with extension
        if (
          /\/[^/]*\.[a-zA-Z0-9]+$/.test(new URL(event.request.url).pathname)
        ) {
          return;
        }
        Object.defineProperty(event.request, "waitUntil", {
          value: event.waitUntil.bind(event),
        });
        const response = await this.fetch(event.request, event);
        if (response.status !== 404) {
          event.respondWith(response);
        }
      };

      addEventListener("fetch", this.#fetchListener);

      self.addEventListener("install", () => {
        self.skipWaiting();
      });

      self.addEventListener("activate", () => {
        self.clients?.claim?.();
      });
    }
  }

  ready(): Promise<Server<ServiceWorkerHandler>> {
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  async close() {
    if (this.#fetchListener) {
      removeEventListener("fetch", this.#fetchListener!);
    }

    // unregister the service worker
    if (isBrowserWindow) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        if (registration.active) {
          await registration.unregister();
        }
      }
    } else if (isServiceWorker) {
      await self.registration.unregister();
    }
  }
}
