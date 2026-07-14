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

const isBrowserWindow = typeof window !== "undefined" && typeof navigator !== "undefined";

const isServiceWorker = /* @__PURE__ */ (() =>
  typeof self !== "undefined" && "skipWaiting" in self)();

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
        throw new Error("Service worker is not supported in the current window.");
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
        .then(() => {
          // If the page is already controlled by an active service worker,
          // it can handle requests right away and no reload is needed.
          if (navigator.serviceWorker.controller) {
            return;
          }
          // Otherwise reload once the freshly installed worker takes control
          // (via `clients.claim()`) so it can handle the current page.
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => {
              location.reload();
            },
            { once: true },
          );
        });
    } else if (isServiceWorker) {
      // Listen for the 'fetch' event to handle requests
      this.#fetchListener = (event) => {
        Object.defineProperty(event.request, "waitUntil", {
          value: event.waitUntil.bind(event),
        });
        // `respondWith` must be called synchronously (before the event
        // dispatch completes), passing a promise that resolves the response.
        event.respondWith(
          (async () => {
            const response = await this.fetch(event.request, event);
            // Treat a 404 from the handler as "not handled" and fall back
            // to the network for the original request.
            return response.status === 404 ? fetch(event.request) : response;
          })(),
        );
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
