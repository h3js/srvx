/**
 * Tests for `X-Forwarded-Proto` trust gating in the Node.js adapter.
 *
 * Background: `NodeRequestURL` used to trust `X-Forwarded-Proto` (and the
 * HTTP/2 `:scheme` pseudo-header) unconditionally, so any client on a plaintext
 * connection could send `X-Forwarded-Proto: https` and make
 * `request.url.protocol === "https:"`. The `trustProxy` option now gates this;
 * it defaults to `false` (secure).
 */

import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import { serve } from "../src/adapters/node.ts";
import type { Server, ServerOptions } from "../src/types.ts";

/** Send a raw HTTP request with custom headers (fetch normalizes headers). */
function rawRequest(
  port: number,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "GET", path: "/", hostname: "127.0.0.1", port, headers, timeout: 2000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    req.end();
  });
}

function getPort(server: Server): number {
  const addr = server.node?.server?.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("Cannot determine server port");
}

describe("trustProxy protocol gating (Node)", () => {
  let server: Server;

  async function start(options: Partial<ServerOptions>) {
    server = serve({
      port: 0,
      fetch: (request) => new Response(new URL(request.url).protocol),
      ...options,
    } as ServerOptions);
    await server.ready();
    return getPort(server);
  }

  afterEach(async () => {
    if (server) await server.close(true);
  });

  test("default (trustProxy unset) ignores X-Forwarded-Proto on plaintext", async () => {
    const port = await start({});
    const { statusCode, body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(statusCode).toBe(200);
    expect(body).toBe("http:");
  });

  test("trustProxy: false ignores X-Forwarded-Proto", async () => {
    const port = await start({ trustProxy: false });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("http:");
  });

  test("trustProxy: true honors X-Forwarded-Proto", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("https:");
  });

  test("trustProxy: true honors the leftmost entry of a comma-joined X-Forwarded-Proto", async () => {
    // A proxy chain can join the header (e.g. "https, http"); the outermost
    // (leftmost) value reflects the original client's scheme.
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https, http" });
    expect(body).toBe("https:");
  });

  test('trustProxy: "loopback" trusts a same-host peer', async () => {
    // The test client connects over loopback (127.0.0.1 / ::1).
    const port = await start({ trustProxy: "loopback" });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("https:");
  });

  test("trustProxy allowlist honors trusted peer address", async () => {
    // The loopback peer address is allowlisted. On dual-stack it may be reported
    // as the IPv4-mapped `::ffff:127.0.0.1`, which isTrustedProxy matches against
    // the bare `127.0.0.1` entry, so only the two canonical forms are listed.
    const port = await start({ trustProxy: ["127.0.0.1", "::1"] });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("https:");
  });

  test("no forwarded header stays http on plaintext regardless of trustProxy", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {});
    expect(body).toBe("http:");
  });
});

describe("trustProxy host gating (Node)", () => {
  let server: Server;

  async function start(options: Partial<ServerOptions>) {
    server = serve({
      port: 0,
      fetch: (request) => new Response(new URL(request.url).host),
      ...options,
    } as ServerOptions);
    await server.ready();
    return getPort(server);
  }

  afterEach(async () => {
    if (server) await server.close(true);
  });

  test("default (trustProxy unset) ignores X-Forwarded-Host", async () => {
    const port = await start({});
    const { body } = await rawRequest(port, {
      Host: "real.example",
      "X-Forwarded-Host": "spoofed.example",
    });
    expect(body).toBe("real.example");
  });

  test("trustProxy: true honors X-Forwarded-Host", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {
      Host: "real.example",
      "X-Forwarded-Host": "forwarded.example",
    });
    expect(body).toBe("forwarded.example");
  });

  test("trustProxy: true uses first entry of an X-Forwarded-Host chain", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {
      Host: "real.example",
      "X-Forwarded-Host": "outer.example, inner.example",
    });
    expect(body).toBe("outer.example");
  });

  test("falls back to Host when X-Forwarded-Host is absent", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, { Host: "real.example" });
    expect(body).toBe("real.example");
  });

  test("falls back to Host when a trusted X-Forwarded-Host is malformed", async () => {
    // A malformed forwarded host must not poison request.url (previously became
    // "_invalid_"); fall back to the real Host, matching the Bun/Deno plugin.
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {
      Host: "real.example",
      "X-Forwarded-Host": "bad_host:notaport",
    });
    expect(body).toBe("real.example");
  });
});

describe("trustProxy client IP gating (Node)", () => {
  let server: Server;

  async function start(options: Partial<ServerOptions>) {
    server = serve({
      port: 0,
      fetch: (request) => new Response(request.ip ?? ""),
      ...options,
    } as ServerOptions);
    await server.ready();
    return getPort(server);
  }

  afterEach(async () => {
    if (server) await server.close(true);
  });

  test("default (trustProxy unset) ignores X-Forwarded-For", async () => {
    const port = await start({});
    const { body } = await rawRequest(port, { "X-Forwarded-For": "1.2.3.4" });
    // The real loopback peer address, not the spoofed header.
    expect(body).not.toBe("1.2.3.4");
    expect(body).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  test("trustProxy: true honors X-Forwarded-For", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, { "X-Forwarded-For": "1.2.3.4" });
    expect(body).toBe("1.2.3.4");
  });

  test("all hops trusted (trustProxy: true) -> leftmost X-Forwarded-For entry", async () => {
    // Every address is trusted, so the outermost (leftmost) entry is the client,
    // matching Express `trust proxy: true`.
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {
      "X-Forwarded-For": "1.2.3.4, 10.0.0.1, 10.0.0.2",
    });
    expect(body).toBe("1.2.3.4");
  });

  test("hop-aware: rightmost untrusted entry is the client, not a spoofed prefix", async () => {
    // Only the loopback peer is trusted. An attacker prepends `9.9.9.9`; the
    // trusted proxy appends the attacker's real address `1.2.3.4`. Walking
    // right-to-left, `1.2.3.4` is the first untrusted hop and wins — the old
    // leftmost behavior would have returned the spoofed `9.9.9.9`.
    const port = await start({ trustProxy: ["127.0.0.1", "::1"] });
    const { body } = await rawRequest(port, {
      "X-Forwarded-For": "9.9.9.9, 1.2.3.4",
    });
    expect(body).toBe("1.2.3.4");
  });

  test("untrusted peer -> X-Forwarded-For ignored entirely", async () => {
    // The allowlist does not include the loopback peer, so the whole header is
    // ignored and the real peer address is used.
    const port = await start({ trustProxy: ["10.0.0.1"] });
    const { body } = await rawRequest(port, {
      "X-Forwarded-For": "1.2.3.4",
    });
    expect(body).not.toBe("1.2.3.4");
    expect(body).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  test("falls back to peer address when X-Forwarded-For is absent", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {});
    expect(body).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });
});
