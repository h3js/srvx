import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { serve } from "../src/adapters/cloudflare.ts";

// NOTE: This is a best-effort in-process test. The plan's preferred option is a
// `@cloudflare/vitest-pool-workers` smoke job, but that pool requires its own
// vitest project/worker runtime (wrangler + a separate config) that conflicts
// with the existing single-config Node-based suite. Instead we mock the
// service-worker `addEventListener`/`removeEventListener` globals and exercise
// the module-worker `fetch(request, env, context)` export directly, which
// covers all three F29 behaviors (single registration, `close()` removal, and
// `env` threading) plus the `configurable` `ip`.

function mockContext() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;
}

describe("cloudflare adapter", () => {
  let listeners: Array<{ type: string; listener: EventListener }>;

  beforeEach(() => {
    listeners = [];
    vi.stubGlobal("addEventListener", (type: string, listener: EventListener) => {
      listeners.push({ type, listener });
    });
    vi.stubGlobal("removeEventListener", (type: string, listener: EventListener) => {
      const i = listeners.findIndex((l) => l.type === type && l.listener === listener);
      if (i !== -1) listeners.splice(i, 1);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("module-worker export", () => {
    test("threads real env and context into request.runtime.cloudflare", async () => {
      const server = serve({ manual: true, fetch: () => new Response("ok") });

      const env = { MY_KV: {}, SECRET: "s3cr3t" };
      const ctx = mockContext();
      let seen: any;
      const server2 = serve({
        manual: true,
        fetch: (req) => {
          seen = (req as any).runtime;
          return new Response("ok");
        },
      });
      await server2.fetch(new Request("http://localhost/") as any, env as any, ctx);

      expect(seen.name).toBe("cloudflare");
      expect(seen.cloudflare.env).toBe(env);
      expect(seen.cloudflare.context).toBe(ctx);
      // Keep `server` referenced so its constructor path is covered too.
      expect(server.runtime).toBe("cloudflare");
    });

    test("wires waitUntil to context.waitUntil", async () => {
      const ctx = mockContext();
      let captured: ((p: Promise<unknown>) => void) | undefined;
      const server = serve({
        manual: true,
        fetch: (req) => {
          captured = (req as any).waitUntil;
          return new Response("ok");
        },
      });
      await server.fetch(new Request("http://localhost/") as any, {} as any, ctx);
      const p = Promise.resolve();
      captured!(p);
      expect(ctx.waitUntil).toHaveBeenCalledWith(p);
    });

    test("sets request.ip from cf-connecting-ip and it is configurable", async () => {
      let ip: string | null | undefined;
      const server = serve({
        manual: true,
        fetch: (req) => {
          ip = (req as any).ip;
          // `configurable: true` lets trustProxy-style overrides redefine it.
          expect(Object.getOwnPropertyDescriptor(req, "ip")?.configurable).toBe(true);
          return new Response("ok");
        },
      });
      await server.fetch(
        new Request("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } }) as any,
        {} as any,
        mockContext(),
      );
      expect(ip).toBe("9.9.9.9");
    });
  });

  describe("service-worker fetch listener (F29)", () => {
    test("registers exactly one fetch listener on serve()", () => {
      serve({ fetch: () => new Response("ok") }); // auto-serve in constructor
      expect(listeners.filter((l) => l.type === "fetch")).toHaveLength(1);
    });

    test("does not stack listeners across repeated serve() calls", () => {
      const server = serve({ manual: true, fetch: () => new Response("ok") });
      server.serve();
      server.serve();
      server.serve();
      expect(listeners.filter((l) => l.type === "fetch")).toHaveLength(1);
    });

    test("close() removes the listener it registered", async () => {
      const server = serve({ fetch: () => new Response("ok") });
      expect(listeners.filter((l) => l.type === "fetch")).toHaveLength(1);
      await server.close();
      expect(listeners.filter((l) => l.type === "fetch")).toHaveLength(0);
    });

    test("the listener responds via event.respondWith", async () => {
      serve({ fetch: () => new Response("hello", { status: 201 }) });
      const listener = listeners.find((l) => l.type === "fetch")!.listener;

      let responded: Promise<Response> | undefined;
      const event = {
        request: new Request("http://localhost/"),
        respondWith: (r: any) => (responded = r),
        waitUntil: vi.fn(),
      };
      listener(event as any);

      const res = await responded!;
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("hello");
    });
  });
});
