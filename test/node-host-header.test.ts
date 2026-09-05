/**
 * Tests for malformed Host header handling in Node.js adapter.
 *
 * Background: srvx commit 7c8c962 added HOST_RE validation that throws
 * TypeError for invalid Host headers. While the validation itself is
 * correct, throwing is too aggressive. A constructor exception inside
 * NodeRequestURL becomes an uncaughtException that kills the process
 * because there is no try/catch in the Node adapter's handler.
 *
 * The fix: instead of throwing, invalid Host headers are replaced with
 * "_invalid_" so the request can be processed safely. This avoids
 * falling back to the socket address, which could allow requests with
 * forged Host headers to bypass localhost-only authentication.
 */

import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import net from "node:net";
import { serve } from "../src/adapters/node.ts";
import type { Server } from "../src/types.ts";

/**
 * Send a raw HTTP request with a custom Host header.
 * Uses http.request because fetch() normalizes headers.
 */
function rawRequest(port: number, host: string): Promise<{ statusCode: number; body: string }> {
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
  "localhost:3000/foobar", // path in host
  "example.com?query=1", // query in host
  "host with spaces", // spaces
  "evil@host.com", // @ sign
  "<script>alert(1)</script>", // XSS attempt
  "host:port:extra", // double colon
];

describe("malformed Host header handling", () => {
  let server: Server;

  afterEach(async () => {
    if (server) {
      await server.close(true);
    }
  });

  test("malformed Host is replaced with _invalid_, not crash", async () => {
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
    expect(result.body).not.toContain("malicious-path");
    expect(result.body).toContain("_invalid_");
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
    expect(malformed.body).toContain("_invalid_");

    // Valid request afterwards
    const valid = await rawRequest(port, "localhost");
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain("localhost");
  });

  test.each(MALFORMED_HOSTS)("malformed Host %s is replaced with _invalid_", async (hostValue) => {
    server = serve({
      port: 0,
      fetch(request) {
        return new Response(request.url);
      },
    });
    await server.ready();
    const port = getPort(server);

    const result = await rawRequest(port, hostValue);

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("_invalid_");
  });

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
    const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
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
    });

    expect(result.statusCode).toBe(200);
    // Socket-derived fallback: URL should contain the actual port
    expect(result.body).toContain(String(port));
  });
});

/**
 * RFC 9112 §3.2.2 makes absolute-form (`GET http://host/p HTTP/1.1`) a
 * MUST-accept for origin servers, and §3.3 says its authority supersedes
 * `Host` — but srvx is not a proxy, so the request-line target must not become
 * a way around the guarantees `Host` already gets. These assert the invariants
 * end-to-end on a plaintext listener with the default `trustProxy: false`.
 */
describe("absolute-form request target", () => {
  let server: Server;

  afterEach(async () => {
    if (server) {
      await server.close(true);
    }
  });

  /** Responses are chunked-encoded on the wire; pull the JSON body out. */
  function jsonBody(body: string): any {
    return JSON.parse(body.match(/\{.*\}/s)![0]);
  }

  /** Send an arbitrary raw request line (http.request rewrites some of these). */
  function rawLine(
    port: number,
    requestLine: string,
    host = "good.example",
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`${requestLine}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        const statusLine = data.split("\r\n")[0] || "";
        resolve({
          statusCode: Number.parseInt(statusLine.split(" ")[1], 10),
          body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
        });
      });
      socket.on("error", reject);
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("socket timed out"));
      });
    });
  }

  async function serveURLInfo(): Promise<number> {
    server = serve({
      port: 0,
      fetch(request) {
        // `clone()` builds the native Request, which throws on a URL with
        // credentials — a userinfo target used to become an unauthenticated 500.
        request.clone();
        const url = new URL(request.url);
        return new Response(
          JSON.stringify({
            url: request.url,
            protocol: url.protocol,
            host: url.host,
            origin: url.origin,
            username: url.username,
          }),
        );
      },
    });
    await server.ready();
    return getPort(server);
  }

  test("cannot claim https: on a plaintext socket", async () => {
    const port = await serveURLInfo();
    const result = await rawLine(port, "GET https://evil.example.com/x HTTP/1.1");
    expect(result.statusCode).toBe(200);
    const data = jsonBody(result.body);
    expect(data.protocol).toBe("http:");
    expect(data.origin).toBe("http://evil.example.com");
    expect(data.url).toBe("http://evil.example.com/x");
  });

  test("userinfo is dropped instead of crashing the native Request (500)", async () => {
    const port = await serveURLInfo();
    const result = await rawLine(port, "GET http://evil.example.com@real.example/admin HTTP/1.1");
    expect(result.statusCode).toBe(200);
    const data = jsonBody(result.body);
    expect(data.username).toBe("");
    expect(data.host).toBe("real.example");
    expect(data.url).toBe("http://real.example/admin");
  });

  test("a HOST_RE-invalid request-line authority becomes _invalid_", async () => {
    const port = await serveURLInfo();
    const result = await rawLine(port, "GET http://evil.example.com./x HTTP/1.1");
    expect(result.statusCode).toBe(200);
    expect(jsonBody(result.body).host).toBe("_invalid_");
  });

  test("non-http(s) schemes are rejected with 400", async () => {
    const port = await serveURLInfo();
    for (const line of [
      "GET file:///etc/passwd HTTP/1.1",
      "GET file://hehe/x HTTP/1.1",
      "GET ftp://evil.com/ HTTP/1.1",
      "GET zzz://evil/x HTTP/1.1",
    ]) {
      expect((await rawLine(port, line)).statusCode, line).toBe(400);
    }
  });

  test("control: x-forwarded-* stays ignored with trustProxy: false", async () => {
    const port = await serveURLInfo();
    const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /foo HTTP/1.1\r\nHost: good.example\r\n" +
            "X-Forwarded-Host: evil.example.com\r\nX-Forwarded-Proto: https\r\n" +
            "Connection: close\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () =>
        resolve({
          statusCode: Number.parseInt((data.split("\r\n")[0] || "").split(" ")[1], 10),
          body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
        }),
      );
      socket.on("error", reject);
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("socket timed out"));
      });
    });
    expect(result.statusCode).toBe(200);
    const data = jsonBody(result.body);
    expect(data.url).toBe("http://good.example/foo");
  });
});
