import type { ServerRequest } from "./core.mjs";

declare module "./core.mjs" {
  interface RuntimeTypes {
    "service-worker.context": { event: ServiceWorkerFetchEvent };
  }
}

/**
 * Minimal shape srvx relies on from the service worker `FetchEvent`.
 *
 * Only used when the environment declares no global `FetchEvent`, so that this entry
 * needs no ambient service worker types of its own.
 */
export interface FetchEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The global `FetchEvent` when `@types/serviceworker` or `lib: ["webworker"]` is in
 * use, and {@link FetchEventLike} otherwise.
 */
export type ServiceWorkerFetchEvent = typeof globalThis extends {
  FetchEvent: abstract new (...args: never) => infer Event;
}
  ? Event
  : FetchEventLike;

export type ServiceWorkerHandler = (
  request: ServerRequest,
  event: ServiceWorkerFetchEvent,
) => Response | Promise<Response>;
