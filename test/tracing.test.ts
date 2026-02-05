import { describe, it, expect, afterEach } from "vitest";
import { tracingChannel } from "node:diagnostics_channel";
import { serve } from "../src/adapters/node.ts";
import { tracingPlugin } from "../src/tracing.ts";
import type { ServerMiddleware } from "../src/types.ts";

// Helper to create no-op handlers for unused tracing events
const noop = () => {};

describe("tracing channels", () => {
  const cleanupFns: Array<() => void> = [];

  afterEach(() => {
    // Clean up all subscriptions after each test
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns.length = 0;
  });

  it("should emit fetch tracing events", async () => {
    const events: Array<{ type: string; method?: string }> = [];

    const fetchChannel = tracingChannel("srvx.request");

    const startHandler = (data: any) => {
      events.push({ type: "fetch.start", method: data.request.method });
    };

    const endHandler = (data: any) => {
      events.push({ type: "fetch.end", method: data.request.method });
    };

    fetchChannel.subscribe({
      start: startHandler,
      end: endHandler,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });

    cleanupFns.push(() => {
      fetchChannel.unsubscribe({
        start: startHandler,
        end: endHandler,
        asyncStart: noop,
        asyncEnd: noop,
        error: noop,
      });
    });

    const server = serve({
      fetch: () => new Response("OK"),
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/test");
    await server.fetch(request);

    expect(events).toContainEqual({ type: "fetch.start", method: "GET" });
    expect(events).toContainEqual({ type: "fetch.end", method: "GET" });
  });

  it("should emit middleware tracing events", async () => {
    const events: Array<{ type: string; name?: string; index?: number }> = [];

    const middlewareChannel = tracingChannel("srvx.middleware");

    const startHandler = (data: any) => {
      events.push({
        type: "middleware.start",
        name: data.middleware.handler.name,
        index: data.middleware.index,
      });
    };

    const endHandler = (data: any) => {
      events.push({
        type: "middleware.end",
        name: data.middleware.handler.name,
        index: data.middleware.index,
      });
    };

    middlewareChannel.subscribe({
      start: startHandler,
      end: endHandler,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: startHandler,
        end: endHandler,
        asyncStart: noop,
        asyncEnd: noop,
        error: noop,
      });
    });

    const middleware1: ServerMiddleware = async (request, next) => {
      return next();
    };
    Object.defineProperty(middleware1, "name", { value: "middleware1" });

    const middleware2: ServerMiddleware = async (request, next) => {
      return next();
    };
    Object.defineProperty(middleware2, "name", { value: "middleware2" });

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [middleware1, middleware2],
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");
    await server.fetch(request);

    // Check that all middleware events were emitted
    expect(events).toContainEqual({
      type: "middleware.start",
      name: "middleware1",
      index: 0,
    });
    expect(events).toContainEqual({
      type: "middleware.end",
      name: "middleware1",
      index: 0,
    });
    expect(events).toContainEqual({
      type: "middleware.start",
      name: "middleware2",
      index: 1,
    });
    expect(events).toContainEqual({
      type: "middleware.end",
      name: "middleware2",
      index: 1,
    });
  });

  it("should emit asyncStart and asyncEnd events", async () => {
    const events: Array<string> = [];

    const middlewareChannel = tracingChannel("srvx.middleware");

    const asyncStartHandler = () => {
      events.push("middleware.asyncStart");
    };

    const asyncEndHandler = () => {
      events.push("middleware.asyncEnd");
    };

    middlewareChannel.subscribe({
      start: noop,
      end: noop,
      asyncStart: asyncStartHandler,
      asyncEnd: asyncEndHandler,
      error: noop,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: noop,
        end: noop,
        asyncStart: asyncStartHandler,
        asyncEnd: asyncEndHandler,
        error: noop,
      });
    });

    const middleware: ServerMiddleware = async (request, next) => {
      return next();
    };

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [middleware],
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");
    await server.fetch(request);

    expect(events).toContain("middleware.asyncStart");
    expect(events).toContain("middleware.asyncEnd");
  });

  it("should emit error events on middleware errors", async () => {
    const events: Array<{ type: string; error?: string }> = [];

    const middlewareChannel = tracingChannel("srvx.middleware");

    const errorHandler = (data: any) => {
      events.push({ type: "middleware.error", error: data.error?.message });
    };

    middlewareChannel.subscribe({
      start: noop,
      end: noop,
      asyncStart: noop,
      asyncEnd: noop,
      error: errorHandler,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: noop,
        end: noop,
        asyncStart: noop,
        asyncEnd: noop,
        error: errorHandler,
      });
    });

    const middleware: ServerMiddleware = async () => {
      throw new Error("Test error");
    };

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [middleware],
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");

    // Expect the fetch to throw
    await expect(server.fetch(request)).rejects.toThrow("Test error");

    expect(events).toContainEqual({
      type: "middleware.error",
      error: "Test error",
    });
  });

  it("should include request and server data in events", async () => {
    let capturedData: any = null;

    const middlewareChannel = tracingChannel("srvx.middleware");

    const startHandler = (data: any) => {
      capturedData = data;
    };

    middlewareChannel.subscribe({
      start: startHandler,
      end: noop,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: startHandler,
        end: noop,
        asyncStart: noop,
        asyncEnd: noop,
        error: noop,
      });
    });

    const middleware: ServerMiddleware = async (request, next) => {
      return next();
    };

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [middleware],
      plugins: [tracingPlugin()],
      manual: true,
      port: 3000,
    });

    const request = new Request("http://localhost:3000/test");
    await server.fetch(request);

    expect(capturedData).toBeDefined();
    expect(capturedData.request).toBeDefined();
    expect(capturedData.server).toBeDefined();
    expect(capturedData.middleware.index).toBe(0);
    expect(capturedData.server.options.port).toBe(3000);
  });

  it("should emit events for multiple middleware in sequence", async () => {
    const events: Array<{ type: string; name: string }> = [];

    const middlewareChannel = tracingChannel("srvx.middleware");

    const startHandler = (data: any) => {
      events.push({ type: "start", name: data.middleware.handler.name });
    };

    const endHandler = (data: any) => {
      events.push({ type: "end", name: data.middleware.handler.name });
    };

    middlewareChannel.subscribe({
      start: startHandler,
      end: endHandler,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: startHandler,
        end: endHandler,
        asyncStart: noop,
        asyncEnd: noop,
        error: noop,
      });
    });

    const mw1: ServerMiddleware = async (req, next) => next();
    Object.defineProperty(mw1, "name", { value: "mw1" });

    const mw2: ServerMiddleware = async (req, next) => next();
    Object.defineProperty(mw2, "name", { value: "mw2" });

    const mw3: ServerMiddleware = async (req, next) => next();
    Object.defineProperty(mw3, "name", { value: "mw3" });

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [mw1, mw2, mw3],
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");
    await server.fetch(request);

    // Verify all start and end events were emitted
    const startEvents = events.filter((e) => e.type === "start");
    const endEvents = events.filter((e) => e.type === "end");

    expect(startEvents).toHaveLength(3);
    expect(endEvents).toHaveLength(3);

    expect(startEvents.map((e) => e.name)).toEqual(["mw1", "mw2", "mw3"]);
    expect(endEvents.map((e) => e.name)).toEqual(["mw3", "mw2", "mw1"]);
  });

  it("should emit fetch events when no middleware present", async () => {
    const events: Array<string> = [];

    const fetchChannel = tracingChannel("srvx.request");

    const startHandler = () => {
      events.push("fetch.start");
    };

    const endHandler = () => {
      events.push("fetch.end");
    };

    fetchChannel.subscribe({
      start: startHandler,
      end: endHandler,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });

    cleanupFns.push(() => {
      fetchChannel.unsubscribe({
        start: startHandler,
        end: endHandler,
        asyncStart: noop,
        asyncEnd: noop,
        error: noop,
      });
    });

    const server = serve({
      fetch: () => new Response("OK"),
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");
    await server.fetch(request);

    expect(events).toContain("fetch.start");
    expect(events).toContain("fetch.end");
  });

  it("should provide result in asyncEnd events", async () => {
    const results: Array<any> = [];

    const middlewareChannel = tracingChannel("srvx.middleware");

    const asyncEndHandler = (data: any) => {
      results.push(data.result);
    };

    middlewareChannel.subscribe({
      start: noop,
      end: noop,
      asyncStart: noop,
      asyncEnd: asyncEndHandler,
      error: noop,
    });

    cleanupFns.push(() => {
      middlewareChannel.unsubscribe({
        start: noop,
        end: noop,
        asyncStart: noop,
        asyncEnd: asyncEndHandler,
        error: noop,
      });
    });

    const middleware: ServerMiddleware = async (req, next) => next();

    const server = serve({
      fetch: () => new Response("OK"),
      middleware: [middleware],
      plugins: [tracingPlugin()],
      manual: true,
    });

    const request = new Request("http://localhost:3000/");
    await server.fetch(request);

    // Result should be the Response object
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    expect(results[0]).toBeInstanceOf(Response);
  });
});
