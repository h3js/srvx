/**
 * Tests for malformed Host header handling in Node.js adapter.
 *
 * Background: srvx commit 7c8c962 added HOST_RE validation that throws
 * TypeError for invalid Host headers. While the validation itself is
 * correct, throwing is too aggressive. A constructor exception inside
 * NodeRequestURL becomes an uncaughtException that kills the process
 * because there is no try/catch in the Node adapter's handler.
 *
 * The fix: instead of throwing, invalid Host headers fall back to the
 * socket address (same path as missing Host). The request is processed
 * normally with a safe URL. This matches how other HTTP servers like
 * nginx and Caddy behave. They use the socket address when the Host
 * is unusable, rather than rejecting the request.
 */

import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import { serve } from "../src/adapters/node.ts";
import type { Server } from "../src/types.ts";

/**
 * Send a raw HTTP request with a custom Host header.
 * Uses http.request because fetch() normalizes headers.
 */
function rawRequest(
  port: number,
  host: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "GET",
        path: "/",
        hostname: "127.0.0.1",
        port,
        headers: { Host: host },
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
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

// Malformed Host header values that fail HOST_RE
const MALFORMED_HOSTS = [
  "localhost:3000/foobar",      // path in host
  "example.com?query=1",       // query in host
  "host with spaces",          // spaces
  "evil@host.com",             // @ sign
  "<script>alert(1)</script>", // XSS attempt
  "host:port:extra",           // double colon
];

describe("malformed Host header handling", () => {
  let server: Server;

  afterEach(async () => {
    if (server) {
      await server.close(true);
    }
  });

  test("malformed Host falls back to socket address, not crash", async () => {
    server = serve({
      port: 0,
      fetch(request) {
        return new Response(request.url);
      },
    });
    await server.ready();
    const port = getPort(server);

    const result = await rawRequest(port, "localhost:3000/malicious-path");

    expect(result.statusCode).toBe(200);
    // URL should use socket address, not the malformed host
    expect(result.body).not.toContain("malicious-path");
    expect(result.body).toContain(String(port));
  });

  test("server remains operational after malformed request", async () => {
    server = serve({
      port: 0,
      fetch(request) {
        return new Response(request.url);
      },
    });
    await server.ready();
    const port = getPort(server);

    // Malformed request
    const malformed = await rawRequest(port, "localhost:3000/evil");
    expect(malformed.statusCode).toBe(200);

    // Valid request afterwards -- server must still work
    const valid = await rawRequest(port, "localhost");
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain("localhost");
  });

  test.each(MALFORMED_HOSTS)(
    "malformed Host %s falls back gracefully",
    async (hostValue) => {
      server = serve({
        port: 0,
        fetch(request) {
          return new Response(request.url);
        },
      });
      await server.ready();
      const port = getPort(server);

      const result = await rawRequest(port, hostValue);

      // Must not crash -- should process normally with fallback URL
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain(String(port));
    },
  );

  test("valid Host headers work normally", async () => {
    server = serve({
      port: 0,
      fetch(request) {
        return new Response(request.url);
      },
    });
    await server.ready();
    const port = getPort(server);

    const validHosts = [
      "localhost",
      "localhost:3000",
      "example.com",
      "sub.example.com:8080",
      "127.0.0.1",
      "127.0.0.1:3000",
      "[::1]",
      "[::1]:3000",
    ];

    for (const host of validHosts) {
      const result = await rawRequest(port, host);
      expect(result.statusCode).toBe(200);
      // URL must contain the hostname part (without port, since URL
      // normalization may strip non-standard ports)
      const hostname = host.replace(/:\d+$/, "").replace(/[[\]]/g, "");
      expect(result.body).toContain(hostname);
    }
  });

  test("missing Host header falls back to socket address", async () => {
    server = serve({
      port: 0,
      fetch(request) {
        return new Response(request.url);
      },
    });
    await server.ready();
    const port = getPort(server);

    // HTTP/1.0 without Host header
    const result = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const net = require("node:net");
        const socket = new net.Socket();
        socket.connect(port, "127.0.0.1", () => {
          socket.write("GET / HTTP/1.0\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        socket.on("end", () => {
          const statusLine = data.split("\r\n")[0];
          const statusCode = Number.parseInt(statusLine.split(" ")[1], 10);
          const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
          resolve({ statusCode, body });
        });
        socket.on("error", reject);
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error("socket timed out"));
        });
      },
    );

    expect(result.statusCode).toBe(200);
  });
});
