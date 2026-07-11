/**
 * Tests for the universal `trustProxyPlugin` used by the Bun and Deno adapters.
 *
 * These runtimes expose the real transport on the native `Request`, so the
 * plugin runs as middleware that — only when the immediate peer is a trusted
 * proxy — rewrites `request.url` from `X-Forwarded-Proto` / `X-Forwarded-Host`
 * and `request.ip` from `X-Forwarded-For`. The behavior is runtime-agnostic, so
 * it is exercised here against plain `Request` objects.
 */

import { describe, expect, test } from "vitest";
import { trustProxyPlugin } from "../src/_trust-proxy.ts";
import type { Server, ServerRequest, TrustProxyOption } from "../src/types.ts";

function makeRequest(
  url: string,
  peerIp: string | undefined,
  headers: Record<string, string>,
): ServerRequest {
  const req = new Request(url, { headers }) as ServerRequest;
  // Mimic the adapter-provided native `ip` getter (configurable so the plugin
  // may override it).
  Object.defineProperty(req, "ip", {
    value: peerIp,
    enumerable: true,
    configurable: true,
  });
  return req;
}

async function run(
  trustProxy: TrustProxyOption | undefined,
  request: ServerRequest,
): Promise<ServerRequest> {
  const middleware: any[] = [];
  const server = { options: { trustProxy, middleware } } as unknown as Server;
  trustProxyPlugin(server);
  if (middleware.length > 0) {
    await middleware[0](request, () => new Response("ok"));
  }
  return request;
}

describe("trustProxyPlugin", () => {
  test("does not register middleware when trustProxy is unset", () => {
    const middleware: any[] = [];
    trustProxyPlugin({ options: { middleware } } as unknown as Server);
    expect(middleware).toHaveLength(0);
  });

  test("does not register middleware when trustProxy is false", () => {
    const middleware: any[] = [];
    trustProxyPlugin({ options: { trustProxy: false, middleware } } as unknown as Server);
    expect(middleware).toHaveLength(0);
  });

  test("rewrites url and ip when the peer is trusted", async () => {
    const req = await run(
      true,
      makeRequest("http://origin.example/path?q=1", "10.0.0.1", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example",
        "x-forwarded-for": "1.2.3.4",
      }),
    );
    const url = new URL(req.url);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("public.example");
    expect(url.pathname).toBe("/path");
    expect(url.search).toBe("?q=1");
    expect(req.ip).toBe("1.2.3.4");
  });

  test("leaves the request untouched when the peer is not trusted", async () => {
    const req = await run(
      ["10.0.0.1"],
      makeRequest("http://origin.example/", "9.9.9.9", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example",
        "x-forwarded-for": "1.2.3.4",
      }),
    );
    expect(new URL(req.url).host).toBe("origin.example");
    expect(new URL(req.url).protocol).toBe("http:");
    expect(req.ip).toBe("9.9.9.9");
  });

  test('"loopback" trusts a loopback peer', async () => {
    const req = await run(
      "loopback",
      makeRequest("http://origin.example/", "127.0.0.1", {
        "x-forwarded-host": "public.example",
      }),
    );
    expect(new URL(req.url).host).toBe("public.example");
  });

  test('"loopback" ignores a non-loopback peer', async () => {
    const req = await run(
      "loopback",
      makeRequest("http://origin.example/", "203.0.113.5", {
        "x-forwarded-host": "public.example",
      }),
    );
    expect(new URL(req.url).host).toBe("origin.example");
  });

  test("allowlist trusts a listed peer", async () => {
    const req = await run(
      ["10.0.0.1", "10.0.0.2"],
      makeRequest("http://origin.example/", "10.0.0.2", {
        "x-forwarded-for": "1.2.3.4",
      }),
    );
    expect(req.ip).toBe("1.2.3.4");
  });

  test("uses the leftmost X-Forwarded-For entry and first host of a chain", async () => {
    const req = await run(
      true,
      makeRequest("http://origin.example/", "10.0.0.1", {
        "x-forwarded-host": "outer.example, inner.example",
        "x-forwarded-for": "1.2.3.4, 10.0.0.9, 10.0.0.1",
      }),
    );
    expect(new URL(req.url).host).toBe("outer.example");
    expect(req.ip).toBe("1.2.3.4");
  });

  test("X-Forwarded-Host without a port drops the listener port", async () => {
    const req = await run(
      true,
      makeRequest("http://origin.example:34697/", "10.0.0.1", {
        "x-forwarded-host": "public.example",
      }),
    );
    expect(new URL(req.url).host).toBe("public.example");
  });

  test("X-Forwarded-Host may carry its own port", async () => {
    const req = await run(
      true,
      makeRequest("http://origin.example:34697/", "10.0.0.1", {
        "x-forwarded-host": "public.example:8443",
      }),
    );
    const url = new URL(req.url);
    expect(url.hostname).toBe("public.example");
    expect(url.port).toBe("8443");
  });

  test("falls back to the peer address when X-Forwarded-For is absent", async () => {
    const req = await run(
      true,
      makeRequest("http://origin.example/", "10.0.0.1", {
        "x-forwarded-proto": "https",
      }),
    );
    expect(new URL(req.url).protocol).toBe("https:");
    expect(req.ip).toBe("10.0.0.1");
  });
});
