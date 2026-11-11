import net from "node:net";
import http from "node:http";
import http2 from "node:http2";
import { describe, expect, test, type TestContext } from "vitest";
import { serve, toNodeHandler } from "../src/adapters/node.ts";
import { limitRequestBody } from "../src/body-limit.ts";
import { getTLSCert } from "./_utils.ts";
import type { NodeHttp1Handler, ServerOptions, ServerRequest } from "../src/types.ts";

// What happens to the connection after a body-limit 413 (RFC 9112 §9.3/§9.6,
// RFC 9113 §8.1): the body is only partly read, so an HTTP/1.1 connection must
// be closed (after a short, capped drain so the client can read the response)
// and an HTTP/2 stream reset with NO_ERROR. Raw sockets, so the framing and the
// timing of the close are exactly what the client sees.

const LIMIT = 1024 * 1024;
const BODY = 2 * LIMIT;
/** The drain caps in `src/adapters/_node/body-limit.ts`. */
const LINGER_MS = 1000;
const LINGER_BYTES = 1024 * 1024;
/** How long a test waits for something the fix makes happen before failing. */
const GUARD_MS = LINGER_MS + 2500;

type Entry = "maxRequestBodySize" | "limitRequestBody";
type Framing = "content-length" | "chunked";
/** How the handler treats a POST body; `throw` / `reject` fail without reading it. */
type Read = "text" | "stream" | "none" | "throw" | "reject";

const entries: Entry[] = ["maxRequestBodySize", "limitRequestBody"];
const framings: Framing[] = ["content-length", "chunked"];

/** Rejects with `label` if `promise` hasn't settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TestServer = {
  port: number;
  nodeServer: net.Server;
  /** `METHOD path` of every request the handler saw. */
  seen: string[];
  /** When the server's end of the first connection closed, and what it had read. */
  firstClose: Promise<{ at: number; bytesRead: number }>;
};

async function startServer(
  { onTestFinished }: TestContext,
  entry: Entry,
  opts: {
    read?: Read;
    serve?: Partial<ServerOptions>;
    keepAliveTimeout?: number;
    /** Body limit for either entry (default `LIMIT`). */
    limit?: number;
    /**
     * Mount on a plain `node:http` server with `toNodeHandler()` instead of
     * `serve()`; the host answers a handler failure with a 500. `"no-res-req"`
     * also hides `res.req`, as some frameworks' response objects lack it;
     * `"paused"` pauses the request before handing it over.
     */
    toNodeHandler?: true | "no-res-req" | "paused";
  } = {},
): Promise<TestServer> {
  const read = opts.read ?? "text";
  const limit = opts.limit ?? LIMIT;
  const maxRequestBodySize = entry === "maxRequestBodySize" ? limit : undefined;
  const seen: string[] = [];
  const fetch = (request: ServerRequest): Promise<Response> => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === "GET" || read === "none") {
      return Promise.resolve(new Response("ok"));
    }
    if (read === "throw") throw new Error("handler failed");
    if (read === "reject") return Promise.reject(new Error("handler failed"));
    return readBody(request);
  };
  const readBody = async (request: ServerRequest) => {
    const req = entry === "limitRequestBody" ? limitRequestBody(request, limit) : request;
    try {
      let size = 0;
      if (read === "stream") {
        for await (const chunk of req.body!) size += chunk.byteLength;
      } else {
        size = (await req.text()).length;
      }
      return new Response(String(size));
    } catch (error: any) {
      return new Response("too large", { status: error?.status === 413 ? 413 : 500 });
    }
  };

  let nodeServer: net.Server & { keepAliveTimeout?: number };
  if (opts.toNodeHandler) {
    const handler = toNodeHandler(fetch, { maxRequestBodySize }) as NodeHttp1Handler;
    const hideReq = opts.toNodeHandler === "no-res-req";
    nodeServer = http.createServer((req, res) => {
      // A framework's own response object, without Node's `res.req` (hiding it
      // on Node's object itself would trip Node's internal assertions).
      const response = hideReq
        ? new Proxy(res, {
            get(target, prop) {
              if (prop === "req") return undefined;
              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        : res;
      const fail = () => {
        res.statusCode = 500;
        res.end();
      };
      try {
        if (opts.toNodeHandler === "paused") req.pause();
        Promise.resolve(handler(req, response)).catch(fail);
      } catch {
        fail();
      }
    });
    await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
    onTestFinished(async () => {
      (nodeServer as http.Server).closeAllConnections();
      await new Promise((resolve) => nodeServer.close(resolve));
    });
  } else {
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
      gracefulShutdown: false,
      ...opts.serve,
      maxRequestBodySize,
      fetch,
    });
    onTestFinished(() => server.close(true));
    await server.ready();
    nodeServer = server.node!.server! as net.Server;
  }
  if (opts.keepAliveTimeout !== undefined) {
    nodeServer.keepAliveTimeout = opts.keepAliveTimeout;
  }
  let onFirstClose!: (value: { at: number; bytesRead: number }) => void;
  const firstClose = new Promise<{ at: number; bytesRead: number }>((r) => (onFirstClose = r));
  nodeServer.once("connection", (socket: net.Socket) => {
    socket.once("close", () => onFirstClose({ at: Date.now(), bytesRead: socket.bytesRead }));
  });
  return { port: (nodeServer.address() as net.AddressInfo).port, nodeServer, seen, firstClose };
}

function requestHead(framing: Framing, path = "/upload", length = BODY): string {
  return (
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\n` +
    (framing === "content-length"
      ? `Content-Length: ${length}\r\n`
      : "Transfer-Encoding: chunked\r\n") +
    "\r\n"
  );
}

function frame(framing: Framing, chunk: Buffer): Buffer {
  return framing === "content-length"
    ? chunk
    : Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]);
}

/** The whole `BODY`-byte body (plus the chunked terminator), in one buffer. */
function fullBody(framing: Framing): Buffer {
  const parts: Buffer[] = [];
  for (let sent = 0; sent < BODY; sent += 64 * 1024) {
    parts.push(frame(framing, Buffer.alloc(64 * 1024, 97)));
  }
  if (framing === "chunked") parts.push(Buffer.from("0\r\n\r\n"));
  return Buffer.concat(parts);
}

type Parsed = { status: number; headers: Record<string, string> };

/**
 * A raw HTTP/1.1 client connection. `allowHalfOpen` keeps it from closing its
 * side as soon as the server shuts its write side, like a client that is still
 * uploading or waiting for a pipelined response.
 */
function connect(port: number, opts: { paused?: boolean } = {}) {
  const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  if (opts.paused) socket.pause();
  let raw = "";
  let error: (Error & { code?: string }) | undefined;
  let firstResponseAt: number | undefined;
  const firstResponse = new Promise<void>((resolve) => {
    socket.on("data", (data) => {
      raw += data.toString("latin1");
      if (firstResponseAt === undefined && raw.includes("\r\n\r\n")) {
        firstResponseAt = Date.now();
        resolve();
      }
    });
  });
  /** The server shut its side (FIN), or the connection is gone. */
  const ended = new Promise<void>((resolve) => {
    socket.once("end", resolve);
    socket.once("close", resolve);
  });
  socket.on("error", (error_) => (error ??= error_));
  const write = (data: string | Buffer) =>
    new Promise<void>((resolve, reject) =>
      socket.write(data, (error_) => (error_ ? reject(error_) : resolve())),
    );
  /** Status line and headers of every response head received so far. */
  const responses = (): Parsed[] =>
    [...raw.matchAll(/HTTP\/1\.1 (\d{3})[^\r]*\r\n((?:[^\r]+\r\n)*)\r\n/g)].map((m) => ({
      status: Number(m[1]),
      headers: Object.fromEntries(
        m[2]
          .split("\r\n")
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf(":");
            return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
          }),
      ),
    }));
  return {
    socket,
    write,
    responses,
    firstResponse,
    ended,
    get firstResponseAt() {
      return firstResponseAt;
    },
    get error() {
      return error;
    },
  };
}

/** Writes the head, then body chunks until the server answers (the limit trips). */
async function sendUntilResponse(client: ReturnType<typeof connect>, framing: Framing) {
  await client.write(requestHead(framing));
  while (client.firstResponseAt === undefined) {
    await Promise.race([client.write(frame(framing, Buffer.alloc(64 * 1024, 97))), delay(50)]);
    await delay(1);
  }
}

describe("node: connection after a body-limit 413 (HTTP/1.1)", () => {
  for (const entry of entries) {
    for (const framing of framings) {
      const reads: Read[] = entry === "maxRequestBodySize" ? ["text", "stream"] : ["text"];
      for (const read of reads) {
        test.concurrent(`${entry}, ${framing}, ${read}: 413 has Connection: close; a client still sending is closed within the time cap`, async (ctx) => {
          const { port, firstClose } = await startServer(ctx, entry, { read });
          const client = connect(port);
          await within(sendUntilResponse(client, framing), GUARD_MS, "413 response");
          const [res] = client.responses();
          expect(res.status).toBe(413);
          expect(res.headers.connection).toBe("close");
          // Keep uploading slowly (~400 KiB/s, under the byte cap): only the
          // time cap can end this.
          void (async () => {
            while (!client.socket.destroyed) {
              client.socket.write(frame(framing, Buffer.alloc(8 * 1024, 97)));
              await delay(20);
            }
          })();
          const { at } = await within(firstClose, GUARD_MS, "server closing the connection");
          client.socket.destroy();
          // It lingered (so a client that reads late still gets the response),
          // but not much longer than the cap.
          const lingered = at - client.firstResponseAt!;
          expect(lingered).toBeGreaterThanOrEqual(LINGER_MS - 150);
          expect(lingered).toBeLessThan(LINGER_MS + 1500);
        });
      }

      test.concurrent(`${entry}, ${framing}: a client that uploads the whole body before reading gets the 413`, async (ctx) => {
        const { port } = await startServer(ctx, entry);
        const client = connect(port, { paused: true });
        // Reads nothing until the last byte is handed to the kernel, which
        // only happens if the server keeps reading after the limit.
        await within(
          client.write(requestHead(framing)).then(() => client.write(fullBody(framing))),
          GUARD_MS,
          "uploading the whole body",
        );
        client.socket.resume();
        await within(client.ended, GUARD_MS, "end of the response stream");
        expect(client.error).toBeUndefined();
        const responses = client.responses();
        expect(responses.map((r) => r.status)).toEqual([413]);
        expect(responses[0].headers.connection).toBe("close");
        client.socket.destroy();
      });

      test.concurrent(`${entry}, ${framing}: a pipelined request after the oversized one is not processed; the connection closes`, async (ctx) => {
        const { port, seen, firstClose } = await startServer(ctx, entry);
        const client = connect(port);
        client
          .write(
            Buffer.concat([
              Buffer.from(requestHead(framing)),
              fullBody(framing),
              Buffer.from("GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n"),
            ]),
          )
          .catch(() => {});
        await within(client.ended, GUARD_MS, "end of the response stream");
        await within(firstClose, GUARD_MS, "server closing the connection");
        expect(client.responses().map((r) => r.status)).toEqual([413]);
        // A `Connection: close` response is the last one (RFC 9112 §9.6).
        expect(seen).toEqual(["POST /upload"]);
        client.socket.destroy();
      });

      test.concurrent(`${entry}, ${framing}: keepAliveTimeout = 0 does not leave the connection open`, async (ctx) => {
        const { port, firstClose } = await startServer(ctx, entry, { keepAliveTimeout: 0 });
        const client = connect(port);
        await within(sendUntilResponse(client, framing), GUARD_MS, "413 response");
        expect(client.responses()[0].status).toBe(413);
        // The client goes quiet without closing; the server must still close.
        await within(firstClose, GUARD_MS, "server closing the connection");
        client.socket.destroy();
      });

      test.concurrent(`${entry}, ${framing}: the drain stops at the byte cap`, async (ctx) => {
        const { port, firstClose } = await startServer(ctx, entry);
        const client = connect(port);
        await client.write(requestHead(framing, "/upload", 64 * LIMIT));
        // Upload as fast as the server takes it, far past what it may drain.
        void (async () => {
          const chunk = frame(framing, Buffer.alloc(256 * 1024, 97));
          for (let i = 0; i < 256 && !client.socket.destroyed; i++) {
            await client.write(chunk).catch(() => {});
          }
        })();
        const { bytesRead } = await within(firstClose, GUARD_MS, "server closing the connection");
        client.socket.destroy();
        // (Past the cap the client may get a reset instead of the 413: it was
        // not reading.) The limit, the drain cap, and what the parser / stream
        // buffers held.
        expect(bytesRead).toBeLessThan(LIMIT + LINGER_BYTES + 512 * 1024);
      });
    }

    test.concurrent(`${entry}: keep-alive and pipelining are unaffected for bodies within the limit`, async (ctx) => {
      const { port, seen } = await startServer(ctx, entry);
      const client = connect(port);
      const small = Buffer.alloc(1000, 97);
      await client.write(
        Buffer.concat([
          Buffer.from(requestHead("content-length", "/a", small.length)),
          small,
          Buffer.from(requestHead("chunked", "/b")),
          frame("chunked", small),
          Buffer.from("0\r\n\r\n"),
          Buffer.from("GET /c HTTP/1.1\r\nHost: localhost\r\n\r\n"),
        ]),
      );
      await within(
        (async () => {
          while (client.responses().length < 3) await delay(5);
        })(),
        GUARD_MS,
        "three pipelined responses",
      );
      await delay(50);
      await client.write("GET /d HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await within(
        (async () => {
          while (client.responses().length < 4) await delay(5);
        })(),
        GUARD_MS,
        "a fourth response on the same connection",
      );
      const responses = client.responses();
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(responses.map((r) => r.headers.connection)).toEqual([
        "keep-alive",
        "keep-alive",
        "keep-alive",
        "keep-alive",
      ]);
      expect(seen).toEqual(["POST /a", "POST /b", "GET /c", "GET /d"]);
      expect(client.socket.destroyed).toBe(false);
      client.socket.destroy();
    });
  }
});

describe("node: client closing after a body-limit 413", () => {
  for (const entry of entries) {
    test.concurrent(`${entry}: is not reported as a client error`, async (ctx) => {
      const { port, nodeServer, firstClose } = await startServer(ctx, entry);
      const clientErrors: string[] = [];
      nodeServer.on("clientError", (error: NodeJS.ErrnoException, socket: net.Socket) => {
        clientErrors.push(error.code ?? error.message);
        socket.destroy();
      });
      const client = connect(port);
      await within(sendUntilResponse(client, "content-length"), GUARD_MS, "413 response");
      expect(client.responses()[0].status).toBe(413);
      // What curl and most clients do on a response to an unfinished upload.
      client.socket.end();
      await within(firstClose, GUARD_MS, "server closing the connection");
      expect(clientErrors).toEqual([]);
    });
  }
});

describe("node: connection after a body-limit 413 (HTTP/1.1, toNodeHandler)", () => {
  for (const entry of entries) {
    for (const framing of framings) {
      test.concurrent(`${entry}, ${framing}: a client that uploads the whole body before reading gets the 413 with Connection: close`, async (ctx) => {
        const { port, seen, firstClose } = await startServer(ctx, entry, { toNodeHandler: true });
        const client = connect(port, { paused: true });
        await within(
          client
            .write(requestHead(framing))
            .then(() =>
              client.write(
                Buffer.concat([
                  fullBody(framing),
                  Buffer.from("GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n"),
                ]),
              ),
            ),
          GUARD_MS,
          "uploading the whole body",
        );
        client.socket.resume();
        await within(client.ended, GUARD_MS, "end of the response stream");
        await within(firstClose, GUARD_MS, "server closing the connection");
        expect(client.error).toBeUndefined();
        const responses = client.responses();
        expect(responses.map((r) => r.status)).toEqual([413]);
        expect(responses[0].headers.connection).toBe("close");
        expect(seen).toEqual(["POST /upload"]);
        client.socket.destroy();
      });
    }
  }

  test.concurrent("maxRequestBodySize: an unread body with a Content-Length over the limit gets Connection: close", async (ctx) => {
    const { port, firstClose } = await startServer(ctx, "maxRequestBodySize", {
      toNodeHandler: true,
      read: "none",
    });
    const client = connect(port);
    await client.write(requestHead("content-length", "/upload", 64 * LIMIT));
    await within(client.firstResponse, GUARD_MS, "response");
    expect(client.responses()[0].headers.connection).toBe("close");
    await within(firstClose, GUARD_MS, "server closing the connection");
    client.socket.destroy();
  });
});

describe("node: over-limit body that arrives whole with a pipelined request", () => {
  // The limit trips while the parser is still in the read that also holds the
  // end of the body and the next request: the body is complete, so the
  // connection is still good and both requests are answered.
  for (const entry of entries) {
    for (const framing of framings) {
      test.concurrent(`${entry}, ${framing}: keeps the connection and answers both`, async (ctx) => {
        const { port, seen } = await startServer(ctx, entry, { limit: 10 });
        const client = connect(port);
        const body = Buffer.alloc(20, 97);
        await client.write(
          Buffer.concat([
            Buffer.from(requestHead(framing, "/upload", body.length)),
            frame(framing, body),
            Buffer.from(framing === "chunked" ? "0\r\n\r\n" : ""),
            Buffer.from("GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n"),
          ]),
        );
        await within(
          (async () => {
            while (client.responses().length < 2) await delay(5);
          })(),
          GUARD_MS,
          "both responses",
        );
        await client.write("GET /third HTTP/1.1\r\nHost: localhost\r\n\r\n");
        await within(
          (async () => {
            while (client.responses().length < 3) await delay(5);
          })(),
          GUARD_MS,
          "a third response on the same connection",
        );
        const responses = client.responses();
        expect(responses.map((r) => r.status)).toEqual([413, 200, 200]);
        expect(responses.map((r) => r.headers.connection)).toEqual([
          "keep-alive",
          "keep-alive",
          "keep-alive",
        ]);
        expect(seen).toEqual(["POST /upload", "GET /second", "GET /third"]);
        client.socket.destroy();
      });
    }
  }
});

describe("node: toNodeHandler settles an unread body on every path", () => {
  const cases = [
    ["a handler that throws", { read: "throw" }],
    ["a handler that rejects", { read: "reject" }],
    ["a response object without `req`", { read: "none", toNodeHandler: "no-res-req" }],
    ["a request the host paused", { read: "none", toNodeHandler: "paused" }],
  ] as const;
  for (const [name, opts] of cases) {
    test.concurrent(`${name}: Content-Length over the limit gets Connection: close and a capped drain`, async (ctx) => {
      const { port, firstClose } = await startServer(ctx, "maxRequestBodySize", {
        toNodeHandler: true,
        ...opts,
      });
      const client = connect(port);
      await client.write(requestHead("content-length", "/upload", 64 * LIMIT));
      await within(client.firstResponse, GUARD_MS, "response");
      const [res] = client.responses();
      expect(res.status).toBe(opts.read === "none" ? 200 : 500);
      expect(res.headers.connection).toBe("close");
      void (async () => {
        const chunk = Buffer.alloc(256 * 1024, 97);
        for (let i = 0; i < 256 && !client.socket.destroyed; i++) {
          await client.write(chunk).catch(() => {});
        }
      })();
      const { bytesRead } = await within(firstClose, GUARD_MS, "server closing the connection");
      client.socket.destroy();
      expect(bytesRead).toBeLessThan(LINGER_BYTES + 512 * 1024);
    });
  }

  for (const variant of ["no-res-req", "paused"] as const) {
    test.concurrent(`${variant}: a chunked unread body is drained only up to the limit`, async (ctx) => {
      const { port, firstClose } = await startServer(ctx, "maxRequestBodySize", {
        toNodeHandler: variant,
        read: "none",
      });
      const client = connect(port);
      await client.write(requestHead("chunked"));
      void (async () => {
        const chunk = frame("chunked", Buffer.alloc(256 * 1024, 97));
        for (let i = 0; i < 256 && !client.socket.destroyed; i++) {
          await client.write(chunk).catch(() => {});
        }
      })();
      const { bytesRead } = await within(firstClose, GUARD_MS, "server closing the connection");
      client.socket.destroy();
      expect(bytesRead).toBeLessThan(LIMIT + LINGER_BYTES + 512 * 1024);
    });
  }
});

describe("node: maxRequestBodySize with a body the handler never reads", () => {
  test.concurrent("a declared Content-Length over the limit gets Connection: close and a capped drain", async (ctx) => {
    const { port, firstClose } = await startServer(ctx, "maxRequestBodySize", { read: "none" });
    const client = connect(port);
    await client.write(requestHead("content-length", "/upload", 64 * LIMIT));
    await within(client.firstResponse, GUARD_MS, "response");
    const [res] = client.responses();
    expect(res.status).toBe(200);
    expect(res.headers.connection).toBe("close");
    void (async () => {
      const chunk = Buffer.alloc(256 * 1024, 97);
      for (let i = 0; i < 256 && !client.socket.destroyed; i++) {
        await client.write(chunk).catch(() => {});
      }
    })();
    const { bytesRead } = await within(firstClose, GUARD_MS, "server closing the connection");
    client.socket.destroy();
    expect(bytesRead).toBeLessThan(LINGER_BYTES + 512 * 1024);
  });

  test.concurrent("a chunked body is drained only up to the limit", async (ctx) => {
    const { port, firstClose } = await startServer(ctx, "maxRequestBodySize", { read: "none" });
    const client = connect(port);
    await client.write(requestHead("chunked"));
    void (async () => {
      const chunk = frame("chunked", Buffer.alloc(256 * 1024, 97));
      for (let i = 0; i < 256 && !client.socket.destroyed; i++) {
        await client.write(chunk).catch(() => {});
      }
    })();
    const { bytesRead } = await within(firstClose, GUARD_MS, "server closing the connection");
    client.socket.destroy();
    expect(bytesRead).toBeLessThan(LIMIT + LINGER_BYTES + 512 * 1024);
  });

  test.concurrent("a body within the limit keeps the connection alive", async (ctx) => {
    const { port, seen } = await startServer(ctx, "maxRequestBodySize", { read: "none" });
    const client = connect(port);
    const small = Buffer.alloc(1000, 97);
    await client.write(
      Buffer.concat([
        Buffer.from(requestHead("chunked", "/a")),
        frame("chunked", small),
        Buffer.from("0\r\n\r\n"),
        Buffer.from(requestHead("content-length", "/b", small.length)),
        small,
        Buffer.from("GET /c HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      ]),
    );
    await within(
      (async () => {
        while (client.responses().length < 3) await delay(5);
      })(),
      GUARD_MS,
      "three pipelined responses",
    );
    expect(client.responses().map((r) => r.headers.connection)).toEqual([
      "keep-alive",
      "keep-alive",
      "keep-alive",
    ]);
    expect(seen).toEqual(["POST /a", "POST /b", "GET /c"]);
    client.socket.destroy();
  });
});

describe.skipIf(!!globalThis.Deno || !!globalThis.Bun)(
  "node: stream after a body-limit 413 (HTTP/2)",
  async () => {
    const tls = await getTLSCert();
    for (const entry of entries) {
      for (const framing of framings) {
        test.concurrent(`${entry}, ${framing}: the upload stream is reset with NO_ERROR; the session keeps working`, async (ctx) => {
          const { port, nodeServer } = await startServer(ctx, entry, {
            serve: { tls: { cert: tls.cert, key: tls.key }, node: { http2: true } },
          });
          // The server's side of the upload stream: reset with NO_ERROR, and
          // actually closed (not left waiting on its unread body).
          const serverStreamClosed = new Promise<number | undefined>((resolve) =>
            nodeServer.once("stream", (stream: http2.ServerHttp2Stream) =>
              stream.once("close", () => resolve(stream.rstCode)),
            ),
          );
          const session = http2.connect(`https://localhost:${port}`, { ca: tls.ca });
          session.on("error", () => {});
          try {
            const headers: http2.OutgoingHttpHeaders = { ":method": "POST", ":path": "/upload" };
            if (framing === "content-length") headers["content-length"] = String(BODY);
            const upload = session.request(headers);
            upload.on("error", () => {});
            const chunk = Buffer.alloc(64 * 1024, 97);
            let sent = 0;
            const pump = () => {
              while (sent < BODY && !upload.destroyed) {
                sent += chunk.length;
                if (!upload.write(chunk)) return void upload.once("drain", pump);
              }
              if (!upload.destroyed) upload.end();
            };
            pump();
            const status = new Promise<number>((resolve) =>
              upload.once("response", (h) => resolve(Number(h[":status"]))),
            );
            upload.resume();
            expect(await within(status, GUARD_MS, "413 response")).toBe(413);
            // Node 22's client stream only emits `aborted` (not `close`) when the
            // peer resets it with NO_ERROR while writes are pending.
            await within(
              new Promise((resolve) => {
                upload.once("close", resolve);
                upload.once("aborted", resolve);
              }),
              GUARD_MS,
              "upload stream reset",
            );
            expect(upload.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
            expect(await within(serverStreamClosed, GUARD_MS, "server stream close")).toBe(
              http2.constants.NGHTTP2_NO_ERROR,
            );
            expect(sent).toBeLessThan(BODY);

            const second = session.request({ ":path": "/second" });
            second.end();
            let text = "";
            second.setEncoding("utf8").on("data", (data) => (text += data));
            await within(
              new Promise((resolve) => second.once("end", resolve)),
              GUARD_MS,
              "second stream",
            );
            expect(text).toBe("ok");
          } finally {
            session.destroy();
          }
        });
      }
    }

    // Frame by frame, on a raw h2c connection: the reset must not overtake the
    // end of the response. (The compat response ends with an empty trailers
    // frame, which Node folds into a final DATA frame with END_STREAM.)
    for (const entry of entries) {
      // `bare`: the handler throws and the host answers with a bare `res.end()`,
      // a headers-only response that gets no trailers.
      for (const kind of ["non-empty", "empty", "bare"] as const) {
        test.concurrent(`${entry}, ${kind} 413: END_STREAM is sent before RST_STREAM`, async ({
          onTestFinished,
        }) => {
          const handler = toNodeHandler(
            async (request) => {
              const req = entry === "limitRequestBody" ? limitRequestBody(request, 10) : request;
              try {
                await req.text();
                return new Response("ok");
              } catch (error) {
                if (kind === "bare") throw error;
                return new Response(kind === "empty" ? null : "too large", { status: 413 });
              }
            },
            { maxRequestBodySize: entry === "maxRequestBodySize" ? 10 : undefined },
          ) as (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => unknown;
          const nodeServer = http2.createServer((req, res) => {
            Promise.resolve(handler(req, res)).catch(() => {
              res.statusCode = 413;
              res.end();
            });
          });
          const sessions = new Set<http2.ServerHttp2Session>();
          nodeServer.on("session", (session) => sessions.add(session));
          await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
          const socket = net.connect((nodeServer.address() as net.AddressInfo).port, "127.0.0.1");
          onTestFinished(async () => {
            socket.destroy();
            for (const session of sessions) session.destroy();
            await new Promise((resolve) => nodeServer.close(resolve));
          });
          const h2Frame = (type: number, flags: number, id: number, payload = Buffer.alloc(0)) => {
            const head = Buffer.alloc(9);
            head.writeUIntBE(payload.length, 0, 3);
            head[3] = type;
            head[4] = flags;
            head.writeUInt32BE(id, 5);
            return Buffer.concat([head, payload]);
          };
          // Stream 1's frames, in order: HEADERS / DATA (`+ES` = END_STREAM), RST=<code>.
          const frames: string[] = [];
          const reset = new Promise<void>((resolve) => {
            let pending = Buffer.alloc(0);
            socket.on("data", (chunk: Buffer) => {
              pending = Buffer.concat([pending, chunk]);
              while (pending.length >= 9) {
                const length = pending.readUIntBE(0, 3);
                if (pending.length < length + 9) break;
                const type = pending[3];
                const flags = pending[4];
                const id = pending.readUInt32BE(5) & 0x7f_ff_ff_ff;
                const payload = pending.subarray(9, 9 + length);
                pending = pending.subarray(length + 9);
                if (id !== 1) continue;
                if (type === 3) {
                  frames.push(`RST=${payload.readUInt32BE(0)}`);
                  resolve();
                } else if (type === 0 || type === 1) {
                  frames.push(`${type === 0 ? "DATA" : "HEADERS"}${flags & 1 ? "+ES" : ""}`);
                }
              }
            });
          });
          // POST / (HPACK static table), http, localhost; 64 body bytes, upload left open.
          const headers = Buffer.concat([
            Buffer.from([0x83, 0x84, 0x86, 0x01, 0x09]),
            Buffer.from("localhost"),
          ]);
          socket.write(
            Buffer.concat([
              Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
              h2Frame(4, 0, 0),
              h2Frame(1, 4, 1, headers),
              h2Frame(0, 0, 1, Buffer.alloc(64, 97)),
            ]),
          );
          await within(reset, GUARD_MS, "RST_STREAM");
          expect(frames[0]).toMatch(/^HEADERS/);
          expect(frames.at(-1)).toBe("RST=0");
          // The response ended (END_STREAM) before the reset.
          expect(frames.slice(0, -1).some((f) => f.endsWith("+ES"))).toBe(true);
        });
      }
    }
  },
);
