import { describe, test, expect, afterEach } from "vitest";
import { serve } from "../src/adapters/node.ts";
import { NodeResponse } from "../src/adapters/_node/response.ts";
import { gracefulShutdownPlugin } from "../src/_plugins.ts";
import type { Server } from "../src/types.ts";

// Behavioral coverage for the v1 "API freeze" batch. Uses the node adapter so
// it runs in the default (node-only) CI job.

describe("v1 api freeze", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length) {
      await cleanup.pop()!();
    }
  });

  test("`error` option runs (errorPlugin wired)", async () => {
    const server = serve({
      port: 0,
      hostname: "localhost",
      fetch: () => {
        throw new Error("boom");
      },
      error: (error) => new Response(`handled: ${(error as Error).message}`, { status: 500 }),
    });
    cleanup.push(() => server.close(true));
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("handled: boom");
  });

  test("`request.context` is lazily initialized and mutable", async () => {
    const server = serve({
      port: 0,
      hostname: "localhost",
      fetch: (req) => {
        // Must not throw: `context` is initialized in shared code.
        req.context!.user = "alice";
        return Response.json({ user: req.context!.user });
      },
    });
    cleanup.push(() => server.close(true));
    await server.ready();

    const res = await fetch(server.url!);
    expect(await res.json()).toEqual({ user: "alice" });
  });

  test("`serve()` returns a Promise that resolves to the server", async () => {
    const server = serve({
      port: 0,
      hostname: "localhost",
      manual: true,
      fetch: () => new Response("ok"),
    });
    cleanup.push(() => server.close(true));

    const ret = server.serve();
    expect(ret).toBeInstanceOf(Promise);
    expect(await ret).toBe(server);
  });

  test("`ready()` rejects on EADDRINUSE while `serve()` does not throw", async () => {
    const first = serve({
      port: 0,
      hostname: "localhost",
      fetch: () => new Response("ok"),
    });
    cleanup.push(() => first.close(true));
    await first.ready();
    const port = Number(new URL(first.url!).port);

    let second!: Server;
    // The top-level serve() must never throw synchronously.
    expect(() => {
      second = serve({
        port,
        hostname: "localhost",
        fetch: () => new Response("ok"),
      });
    }).not.toThrow();
    cleanup.push(() => second.close(true).catch(() => {}));

    // The error surfaces via ready().
    await expect(second.ready()).rejects.toThrow(/EADDRINUSE|address already in use/i);
  });

  describe("NodeResponse null-body status", () => {
    test("throws for a non-null body with a null-body status", () => {
      for (const status of [101, 204, 205, 304]) {
        expect(() => new NodeResponse("x", { status })).toThrow(TypeError);
      }
    });

    test("allows a null body with a null-body status", () => {
      for (const status of [101, 204, 205, 304]) {
        expect(() => new NodeResponse(null, { status })).not.toThrow();
        expect(() => new NodeResponse(undefined, { status })).not.toThrow();
      }
    });

    test("allows a body with a normal status", () => {
      expect(() => new NodeResponse("x", { status: 200 })).not.toThrow();
    });
  });

  test("gracefulShutdown honors `gracefulTimeout: 0` (not treated as falsy default)", async () => {
    const sigListeners = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };

    const closeCalls: Array<boolean | undefined> = [];
    const fakeServer = {
      options: {
        gracefulShutdown: { gracefulTimeout: 0 },
        silent: true,
        middleware: [],
      },
      close: (closeAll?: boolean) => {
        closeCalls.push(closeAll);
        return Promise.resolve();
      },
    } as unknown as Server;

    try {
      gracefulShutdownPlugin(fakeServer);
      // Synchronously invokes the registered handler without signaling the OS.
      process.emit("SIGTERM");
      // Wait past the plugin's 100ms delayed SIGINT (force-close) registration
      // so the cleanup below can remove that listener too.
      await new Promise((r) => setTimeout(r, 150));

      // With timeout 0 the graceful countdown is skipped and it force-closes
      // (`close(true)`) immediately. The old `|| 5` bug would fall back to the
      // 5s default and never force-close a fast-resolving server.
      expect(closeCalls).toContain(true);
    } finally {
      // Remove only the listeners this plugin added.
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        for (const l of process.listeners(sig)) {
          if (!sigListeners[sig].includes(l)) {
            process.removeListener(sig, l);
          }
        }
      }
    }
  });
});
