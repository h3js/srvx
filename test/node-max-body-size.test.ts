import { describe, expect, test } from "vitest";
import { fetch, FormData } from "undici";
import { patchGlobalRequest, serve } from "../src/adapters/node.ts";
import { limitRequestBody } from "../src/body-limit.ts";

describe("node maxRequestBodySize", () => {
  test("rejects a buffered body larger than the limit with a 413-style error", async () => {
    const server = serve({
      port: 0,
      maxRequestBodySize: 8,
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
      maxRequestBodySize: 1024,
      fetch: async (req) => new Response(await req.text()),
    });
    await server.ready();
    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    await server.close(true);
  });

  // The limit must also cover the native `Request` read methods that bypass the
  // buffered `readBody` fallback by routing through `request.body`.
  const bodyReaders = {
    "arrayBuffer()": (req: Request) => req.arrayBuffer().then((b) => b.byteLength),
    "bytes()": (req: Request) => req.bytes().then((b) => b.byteLength),
    "blob()": (req: Request) => req.blob().then((b) => b.size),
    stream: async (req: Request) => {
      let n = 0;
      for await (const chunk of req.body!) n += chunk.length;
      return n;
    },
  } as const;

  for (const [name, read] of Object.entries(bodyReaders)) {
    test(`rejects an oversized body read via ${name}`, async () => {
      const server = serve({
        port: 0,
        maxRequestBodySize: 8,
        fetch: async (req) => {
          try {
            return new Response(String(await read(req)));
          } catch (error: any) {
            return new Response(error.code, { status: error.statusCode ?? 500 });
          }
        },
      });
      await server.ready();
      const res = await fetch(server.url!, { method: "POST", body: "0123456789" });
      expect(res.status).toBe(413);
      expect(await res.text()).toBe("ERR_BODY_TOO_LARGE");
      await server.close(true);
    });
  }

  test("rejects an oversized multipart body via formData()", async () => {
    const server = serve({
      port: 0,
      maxRequestBodySize: 16,
      fetch: async (req) => {
        try {
          const form = await req.formData();
          return new Response(String([...form].length));
        } catch (error: any) {
          return new Response(error.code, { status: error.statusCode ?? 500 });
        }
      },
    });
    await server.ready();
    const form = new FormData();
    form.set("field", "a value long enough to exceed the limit");
    const res = await fetch(server.url!, { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("ERR_BODY_TOO_LARGE");
    await server.close(true);
  });

  test("accepts a body within the limit read via arrayBuffer()", async () => {
    const server = serve({
      port: 0,
      maxRequestBodySize: 1024,
      fetch: async (req) => new Response(String((await req.arrayBuffer()).byteLength)),
    });
    await server.ready();
    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("5");
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

// A per-handler `limitRequestBody()` must hold even when the handler unwraps the
// `ServerRequest` — `req._request` and `new Request(req)` (which `patchGlobalRequest()`
// rewrites to `_request`) both used to hand back the raw, unlimited body stream.
describe("node limitRequestBody _request escape hatch", () => {
  // Chunked: no `content-length`, so the eager over-limit fast path cannot fire
  // and the streaming limit is the only thing standing between the client and
  // an unbounded read.
  const chunkedBody = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
        controller.close();
      },
    });

  const readers = {
    "_request.text()": (req: Request) => (req as any)._request.text(),
    "new Request(req).text()": (req: Request) => {
      patchGlobalRequest();
      return new globalThis.Request(req as any).text();
    },
    "_request.body stream": async (req: Request) => {
      let out = "";
      for await (const chunk of (req as any)._request.body) out += new TextDecoder().decode(chunk);
      return out;
    },
  } as const;

  for (const [name, read] of Object.entries(readers)) {
    test(`rejects an oversized chunked body read via ${name}`, async () => {
      const server = serve({
        port: 0,
        fetch: async (req) => {
          const limited = limitRequestBody(req, 4);
          try {
            return new Response(await read(limited));
          } catch (error: any) {
            return new Response(error.code ?? error.message, { status: error.statusCode ?? 500 });
          }
        },
      });
      await server.ready();
      const res = await fetch(server.url!, {
        method: "POST",
        body: chunkedBody(),
        duplex: "half",
      } as any);
      expect(res.status).toBe(413);
      expect(await res.text()).toBe("ERR_BODY_TOO_LARGE");
      await server.close(true);
    });

    test(`passes a chunked body within the limit through ${name}`, async () => {
      const server = serve({
        port: 0,
        fetch: async (req) => new Response(await read(limitRequestBody(req, 1024))),
      });
      await server.ready();
      const res = await fetch(server.url!, {
        method: "POST",
        body: chunkedBody(),
        duplex: "half",
      } as any);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
      await server.close(true);
    });
  }
});
