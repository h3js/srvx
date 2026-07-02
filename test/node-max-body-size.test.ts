import { describe, expect, test } from "vitest";
import { fetch } from "undici";
import { serve } from "../src/adapters/node.ts";

describe("node maxBodySize", () => {
  test("rejects a buffered body larger than the limit with a 413-style error", async () => {
    const server = serve({
      port: 0,
      maxBodySize: 8,
      fetch: async (req) => {
        try {
          return new Response(await req.text());
        } catch (error: any) {
          return new Response(error.message, { status: error.statusCode ?? 500 });
        }
      },
    });
    await server.ready();
    const res = await fetch(server.url!, { method: "POST", body: "0123456789" });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("maximum allowed size");
    await server.close(true);
  });

  test("accepts a buffered body within the limit", async () => {
    const server = serve({
      port: 0,
      maxBodySize: 1024,
      fetch: async (req) => new Response(await req.text()),
    });
    await server.ready();
    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    await server.close(true);
  });

  test("has no limit by default (backward compatible)", async () => {
    const server = serve({
      port: 0,
      fetch: async (req) => new Response(await req.text()),
    });
    await server.ready();
    const body = "x".repeat(100_000);
    const res = await fetch(server.url!, { method: "POST", body });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(100_000);
    await server.close(true);
  });
});
