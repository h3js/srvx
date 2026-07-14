import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { serve as serveType } from "../src/adapters/service-worker.ts";

// Minimal `FetchEvent`-like object for driving the adapter's fetch listener.
function createFetchEvent(url: string, init?: RequestInit) {
  const request = new Request(url, init);
  return {
    request,
    respondWith: vi.fn<(r: Response | Promise<Response>) => void>(),
    waitUntil: vi.fn(),
  };
}

describe("service-worker adapter", () => {
  let serve: typeof serveType;
  let listeners: Record<string, (event: any) => void>;

  beforeEach(async () => {
    listeners = {};
    const addEventListener = (type: string, listener: (event: any) => void) => {
      listeners[type] = listener;
    };

    // Emulate a service-worker global scope so `isServiceWorker` is truthy and
    // the fetch listener is registered on import.
    vi.stubGlobal("self", {
      skipWaiting: () => {},
      clients: { claim: () => {} },
      registration: { unregister: async () => {} },
      addEventListener,
    });
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", () => {});
    vi.stubGlobal("window", undefined);

    vi.resetModules();
    ({ serve } = await import("../src/adapters/service-worker.ts"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers a fetch listener", () => {
    serve({ fetch: () => new Response("ok") });
    expect(typeof listeners.fetch).toBe("function");
  });

  it("calls respondWith synchronously with a promise", () => {
    serve({ fetch: () => new Response("ok") });
    const event = createFetchEvent("http://localhost/");

    listeners.fetch(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
    expect(event.respondWith.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("serves non-404 responses from the handler", async () => {
    serve({ fetch: () => new Response("hello", { status: 200 }) });
    // A path with a file extension (previously bypassed by the removed regex).
    const event = createFetchEvent("http://localhost/api/data.json");

    listeners.fetch(event);
    const response = await event.respondWith.mock.calls[0][0];

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("falls back to the network for 404 responses", async () => {
    const fetchMock = vi.fn(
      async (_request: Request) => new Response("from network", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    serve({ fetch: () => new Response("nope", { status: 404 }) });
    const event = createFetchEvent("http://localhost/missing");

    listeners.fetch(event);
    const response = await event.respondWith.mock.calls[0][0];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The original request is passed through to the network.
    expect(fetchMock.mock.calls[0][0]).toBe(event.request);
    expect(await response.text()).toBe("from network");
  });
});
