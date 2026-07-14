import { describe, expect, test } from "vitest";
import { serve } from "../src/adapters/generic.ts";

describe("generic adapter", () => {
  test("serves a basic response via server.fetch", async () => {
    const server = serve({
      fetch: () => new Response("ok"),
    });
    expect(server.runtime).toBe("generic");
    const res = await server.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("serve() is a no-op and ready() resolves to the server", async () => {
    const server = serve({ fetch: () => new Response("ok") });
    expect(server.serve()).toBeUndefined();
    await expect(server.ready()).resolves.toBe(server);
  });

  test("exposes request.runtime is unset but waitUntil is available", async () => {
    let hadWaitUntil = false;
    const server = serve({
      fetch: (req) => {
        hadWaitUntil = typeof req.waitUntil === "function";
        return new Response("ok");
      },
    });
    await server.fetch(new Request("http://localhost/"));
    expect(hadWaitUntil).toBe(true);
  });

  test("runs middleware", async () => {
    const server = serve({
      middleware: [(req, next) => (req.headers.has("x-mw") ? new Response("from-mw") : next())],
      fetch: () => new Response("handler"),
    });
    expect(await (await server.fetch(new Request("http://localhost/"))).text()).toBe("handler");
    expect(
      await (
        await server.fetch(new Request("http://localhost/", { headers: { "x-mw": "1" } }))
      ).text(),
    ).toBe("from-mw");
  });

  test("runs plugins", async () => {
    const server = serve({
      plugins: [
        (s) => {
          s.options.middleware!.unshift(async (_req, next) => {
            const res = await next();
            res.headers.set("x-plugin", "1");
            return res;
          });
        },
      ],
      fetch: () => new Response("ok"),
    });
    const res = await server.fetch(new Request("http://localhost/"));
    expect(res.headers.get("x-plugin")).toBe("1");
  });

  test("honors the error option", async () => {
    const server = serve({
      error: (err) => new Response(`caught: ${(err as Error).message}`, { status: 500 }),
      fetch: () => {
        throw new Error("boom");
      },
    });
    const res = await server.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught: boom");
  });

  test("close() awaits pending waitUntil promises", async () => {
    let resolved = false;
    const server = serve({
      fetch: (req) => {
        req.waitUntil!(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              resolved = true;
              resolve();
            }, 20),
          ),
        );
        return new Response("ok");
      },
    });
    await server.fetch(new Request("http://localhost/"));
    expect(resolved).toBe(false);
    await server.close();
    expect(resolved).toBe(true);
  });
});
