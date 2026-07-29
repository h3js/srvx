// Minimal service worker types. See `src/types/README.md` for why these are inlined.

/**
 * Service worker `fetch` event (`FetchEvent`).
 */
export interface ServiceWorkerFetchEvent {
  readonly request: Request;
  readonly clientId?: string;
  respondWith(response: Response | Promise<Response>): void;
  waitUntil(promise: Promise<any>): void;
}
