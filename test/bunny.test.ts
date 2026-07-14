import { afterEach, describe, expect, test, vi } from "vitest";
import { serve } from "../src/adapters/bunny.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bunny adapter", () => {
  test("throws a clear error when the Bunny runtime is absent", () => {
    // No `Bunny` global -> `serve()` (called from the constructor) throws.
    expect(() => serve({ fetch: () => new Response("ok") })).toThrow(/Bunny runtime not detected/);
  });

  test("waitUntil is safe to call outside the Bunny runtime (manual mode)", () => {
    // Regression: the waitUntil closure used to dereference the bare `Bunny`
    // global unconditionally -> `ReferenceError` when running elsewhere.
    const server = serve({ manual: true, fetch: () => new Response("ok") });
    expect(() => server.waitUntil!(Promise.resolve())).not.toThrow();
  });

  test("registers the handler with Bunny.v1.serve", async () => {
    let registered: ((req: Request) => Response | Promise<Response>) | undefined;
    vi.stubGlobal("Bunny", {
      v1: { serve: (h: any) => (registered = h) },
    });

    serve({ fetch: () => new Response("hello") });

    expect(typeof registered).toBe("function");
    const res = await registered!(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("does not register twice across repeated serve() calls", () => {
    const serveSpy = vi.fn();
    vi.stubGlobal("Bunny", { v1: { serve: serveSpy } });

    const server = serve({ fetch: () => new Response("ok") }); // serve() #1 (constructor)
    server.serve(); // #2
    server.serve(); // #3

    expect(serveSpy).toHaveBeenCalledTimes(1);
  });

  test("delegates waitUntil to Bunny.unstable.waitUntil", () => {
    const waitUntilSpy = vi.fn();
    vi.stubGlobal("Bunny", {
      v1: { serve: () => {} },
      unstable: { waitUntil: waitUntilSpy },
    });

    const server = serve({ fetch: () => new Response("ok") });
    const p = Promise.resolve();
    server.waitUntil!(p);
    expect(waitUntilSpy).toHaveBeenCalledWith(p);
  });

  test("sets request.ip from x-real-ip and request.runtime", async () => {
    let registered: ((req: Request) => Response | Promise<Response>) | undefined;
    vi.stubGlobal("Bunny", { v1: { serve: (h: any) => (registered = h) } });

    let seenIp: string | null | undefined;
    let seenRuntime: string | undefined;
    serve({
      fetch: (req) => {
        seenIp = req.ip;
        seenRuntime = req.runtime?.name;
        return new Response("ok");
      },
    });

    await registered!(new Request("http://localhost/", { headers: { "x-real-ip": "1.2.3.4" } }));
    expect(seenIp).toBe("1.2.3.4");
    expect(seenRuntime).toBe("bunny");
  });
});
