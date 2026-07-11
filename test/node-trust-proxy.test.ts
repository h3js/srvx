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

  test('trustProxy: "loopback" trusts a same-host peer', async () => {
    // The test client connects over loopback (127.0.0.1 / ::1).
    const port = await start({ trustProxy: "loopback" });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("https:");
  });

  test("trustProxy allowlist honors trusted peer address", async () => {
    // The loopback peer address (127.0.0.1 or ::1 for dual-stack) is allowlisted.
    const port = await start({ trustProxy: ["127.0.0.1", "::1", "::ffff:127.0.0.1"] });
    const { body } = await rawRequest(port, { "X-Forwarded-Proto": "https" });
    expect(body).toBe("https:");
  });

  test("no forwarded header stays http on plaintext regardless of trustProxy", async () => {
    const port = await start({ trustProxy: true });
    const { body } = await rawRequest(port, {});
    expect(body).toBe("http:");
  });
});
