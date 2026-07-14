import { describe, it, expect } from "vitest";
import { serve } from "../src/adapters/node.ts";
import type { ServerMiddleware } from "../src/types.ts";

// The extension contract: `server.options.middleware` is read live on every request,
// so middleware pushed after construction (the mechanism plugins use) always take
// effect — consistently on both the empty and non-empty initial paths.
describe("middleware extension contract", () => {
  const call = (server: ReturnType<typeof serve>) =>
    server.fetch(new Request("http://localhost/") as any);

  it("applies middleware pushed after construction (empty initial chain)", async () => {
    const server = serve({ fetch: () => new Response("fetch"), manual: true });

    const tag: ServerMiddleware = async (_req, next) => {
      const res = await next();
      res.headers.set("x-added", "1");
      return res;
    };
    server.options.middleware.push(tag);

    const res = await call(server);
    expect(res.headers.get("x-added")).toBe("1");
  });

  it("applies middleware pushed after construction (non-empty initial chain)", async () => {
    const order: string[] = [];
    const first: ServerMiddleware = async (_req, next) => {
      order.push("a");
      return next();
    };
    const server = serve({
      fetch: () => new Response("fetch"),
      middleware: [first],
      manual: true,
    });

    const second: ServerMiddleware = async (_req, next) => {
      order.push("b");
      return next();
    };
    server.options.middleware.push(second);

    await call(server);
    expect(order).toEqual(["a", "b"]);
  });
});
