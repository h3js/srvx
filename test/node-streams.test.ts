import { createServer, request } from "node:http";
import type NodeHttp from "node:http";
import http2 from "node:http2";
import net, { type AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { serve, FastResponse } from "../src/adapters/node.ts";
import { sendNodeResponse, streamBody } from "../src/adapters/_node/send.ts";
import type { NodeServerResponse } from "../src/types.ts";

describe("node response stream error handling", () => {
  test("client abort propagates to node readable stream", async () => {
    let onDestroyed!: (v: boolean) => void;
    const destroyed = new Promise<boolean>((r) => (onDestroyed = r));

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            this.push(Buffer.from("x".repeat(1024)));
          },
          destroy(err, cb) {
            onDestroyed(true);
            cb(err);
          },
        });
        return new Response(stream as unknown as ReadableStream);
      },
    });
    await server.ready();

    const controller = new AbortController();
    const res = await fetch(server.url!, { signal: controller.signal });

    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    reader.cancel().catch(() => {});

    const wasDestroyed = await Promise.race([
      destroyed,
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);

    expect(wasDestroyed).toBe(true);
    await server.close(true);
  });

  // Regression: `pipeBody` waits for the source stream's first 'readable'/'error'
  // before writing headers. If the client goes away during that window, nothing
  // used to observe it: the source stream (and whatever fd/socket backs it) was
  // never destroyed.
  test("client abort before the first chunk destroys the node readable", async () => {
    let onStream!: (s: Readable) => void;
    const streamReady = new Promise<Readable>((r) => (onStream = r));

    const server = serve({
      port: 0,
      fetch() {
        // Never pushes: no 'readable', no 'error'.
        const stream = new Readable({ read() {} });
        onStream(stream);
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    // Raw request instead of fetch(): the abort must land before any byte.
    const req = request(server.url!);
    req.on("error", () => {});
    req.end();

    const stream = await streamReady;
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    await new Promise((r) => setTimeout(r, 300));

    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("readable")).toBe(0);
    await server.close(true);
  });

  // The promise `pipeBody` returns is awaited by `toNodeHandler`/`sendNodeResponse`
  // callers, so a stalled pre-header abort would hang the middleware chain forever.
  test("pipeBody promise settles when the client aborts before the first chunk", async () => {
    const stream = new Readable({ read() {} });
    let onSettled!: () => void;
    const settled = new Promise<void>((r) => (onSettled = r));

    const server = createServer((_req, res) => {
      sendNodeResponse(res, new FastResponse(stream as unknown as BodyInit)).then(onSettled);
    });
    await new Promise<void>((r) => server.listen(0, r));

    const req = request({ port: (server.address() as AddressInfo).port });
    req.on("error", () => {});
    req.end();

    await new Promise((r) => setTimeout(r, 100));
    req.destroy();

    const result = await Promise.race([
      settled.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("hung"), 500)),
    ]);

    expect(result).toBe("settled");
    expect(stream.destroyed).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("node readable stream error terminates response", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            chunkCount++;
            if (chunkCount <= 2) {
              this.push(Buffer.from("x".repeat(1024)));
            } else {
              process.nextTick(() => this.destroy(new Error("read error")));
            }
          },
        });
        stream.on("error", () => {});
        return new Response(stream as unknown as ReadableStream);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);

    const result = await Promise.race([
      res.text().then(
        () => "completed",
        () => "errored",
      ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);

    expect(result).not.toBe("hung");
    await server.close(true);
  });

  test("web readable stream client abort propagates to cancel", async () => {
    let onCancelled!: (v: boolean) => void;
    const cancelled = new Promise<boolean>((r) => (onCancelled = r));

    const server = serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
            },
            cancel() {
              onCancelled(true);
            },
          }),
        );
      },
    });
    await server.ready();

    const controller = new AbortController();
    const res = await fetch(server.url!, { signal: controller.signal });

    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    reader.cancel().catch(() => {});

    const wasCancelled = await Promise.race([
      cancelled,
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);

    expect(wasCancelled).toBe(true);
    await server.close(true);
  });

  test("web readable stream error terminates response gracefully", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              chunkCount++;
              if (chunkCount <= 2) {
                controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
              } else {
                controller.error(new Error("read error"));
              }
            },
          }),
        );
      },
    });
    await server.ready();

    const result = await fetch(server.url!)
      .then((res) => res.text())
      .then(
        () => "completed",
        () => "errored",
      );

    expect(["completed", "errored"]).toContain(result);
    await server.close(true);
  });

  test("FastResponse: node stream early error returns 500", async () => {
    const server = serve({
      port: 0,
      fetch() {
        // Stream that errors before producing any data
        const stream = new Readable({
          read() {
            process.nextTick(() => this.destroy(new Error("init error")));
          },
        });
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    await server.close(true);
  });

  test("FastResponse: node stream with data pipes correctly", async () => {
    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            this.push(Buffer.from("hello stream"));
            this.push(null);
          },
        });
        return new FastResponse(stream as unknown as BodyInit, {
          status: 201,
          headers: { "x-custom": "test" },
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("hello stream");
    await server.close(true);
  });

  test("FastResponse: empty IncomingMessage sends the head", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((r) => upstream.listen(0, r));

    let stream!: Readable;
    const server = serve({
      port: 0,
      fetch() {
        return new Promise<Response>((resolve) => {
          request({ port: (upstream.address() as AddressInfo).port }, (incoming) => {
            stream = incoming;
            resolve(
              new FastResponse(incoming as unknown as BodyInit, {
                status: 400,
                statusText: "Custom Bad Request",
                headers: { "x-custom": "test" },
              }),
            );
          }).end();
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Custom Bad Request");
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("");
    expect(stream.listenerCount("readable")).toBe(0);
    await server.close(true);
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  test("FastResponse: already ended node stream sends the head", async () => {
    const stream = new Readable({ read() {} });
    stream.push(null);
    stream.resume();
    await new Promise((r) => stream.once("end", r));

    const server = serve({
      port: 0,
      fetch() {
        return new FastResponse(stream as unknown as BodyInit, {
          status: 400,
          statusText: "Custom Bad Request",
          headers: { "x-custom": "test" },
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Custom Bad Request");
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("");
    await server.close(true);
  });

  test("FastResponse: node stream that errored after ending responds 500", async () => {
    const stream = new Readable({ read() {}, autoDestroy: false });
    stream.push(null);
    stream.resume();
    await new Promise((r) => stream.once("end", r));
    stream.on("error", () => {});
    stream.destroy(new Error("after end"));

    const server = serve({
      port: 0,
      fetch() {
        return new FastResponse(stream as unknown as BodyInit, { status: 400 });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
    await server.close(true);
  });

  test("FastResponse: ended stream that emits 'end' without 'readable' sends the head", async () => {
    // `end()` on an empty PassThrough emits 'readable' before pipeBody subscribes,
    // so only 'end' is left to observe.
    const server = serve({
      port: 0,
      fetch() {
        const stream = new PassThrough();
        stream.end();
        return new FastResponse(stream as unknown as BodyInit, {
          status: 400,
          statusText: "Custom Bad Request",
          headers: { "x-custom": "test" },
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Custom Bad Request");
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("");
    await server.close(true);
  });

  test("FastResponse: empty node stream that ends later sends the head", async () => {
    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({ read() {} });
        setTimeout(() => stream.push(null), 50);
        return new FastResponse(stream as unknown as BodyInit, {
          status: 400,
          statusText: "Custom Bad Request",
          headers: { "x-custom": "test" },
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Custom Bad Request");
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("");
    await server.close(true);
  });

  test("FastResponse: node stream mid-stream error terminates response", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            chunkCount++;
            if (chunkCount <= 2) {
              this.push(Buffer.from("x".repeat(1024)));
            } else {
              process.nextTick(() => this.destroy(new Error("mid error")));
            }
          },
        });
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const result = await Promise.race([
      fetch(server.url!)
        .then((res) => res.text())
        .then(
          () => "completed",
          () => "errored",
        ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);

    expect(result).not.toBe("hung");
    await server.close(true);
  });

  test("FastResponse: pre-destroyed node stream returns 500", async () => {
    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({ read() {} });
        stream.destroy(new Error("already broken"));
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    await server.close(true);
  });

  // Regression: when the response is already destroyed on entry to streamBody
  // (client gone before we start pumping), we cancel the web stream. If the
  // stream's cancel algorithm rejects (or the stream is locked), the unhandled
  // rejection would crash the process under `--unhandled-rejections=throw`.
  // The cancel() call must be guarded like the HEAD path.
  test("streamBody: destroyed response + cancel-rejecting stream has no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.prependListener("unhandledRejection", onUnhandled);
    try {
      const stream = new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      });
      const destroyedRes = { destroyed: true } as unknown as NodeServerResponse;

      // Should return synchronously (undefined) without leaking a rejection.
      expect(streamBody(stream, destroyedRes)).toBeUndefined();

      // Let the microtask queue flush so a would-be unhandledRejection fires.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("duck-typed pipe object (e.g. React PipeableStream) works", async () => {
    const server = serve({
      port: 0,
      fetch() {
        // Simulate React's renderToPipeableStream which returns { pipe, abort }
        const pipeableStream = {
          pipe(writable: NodeJS.WritableStream) {
            writable.write("hello from pipeable");
            writable.end();
            return writable;
          },
          abort() {},
        };
        return new FastResponse(pipeableStream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from pipeable");
    await server.close(true);
  });

  test("HEAD aborts a duck-typed pipe object instead of piping it", async () => {
    let aborted = false;
    let piped = false;
    const server = serve({
      port: 0,
      fetch() {
        const pipeableStream = {
          pipe(writable: NodeJS.WritableStream) {
            piped = true;
            writable.write("hello from pipeable");
            writable.end();
            return writable;
          },
          abort() {
            aborted = true;
          },
        };
        return new FastResponse(pipeableStream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
    expect(piped).toBe(false);
    await server.close(true);
  });
});

// Buffered bodies are sent with a single `end(body, cb)`. The promise
// `sendNodeResponse` returns (awaited by `toNodeHandler`) must settle once the
// response has finished, and must not hang when the client is gone -- `end()`'s
// callback never fires in that case.
describe("sendNodeResponse buffered bodies", () => {
  type Proto = "http/1.1" | "http/2";
  type Handler = (res: NodeServerResponse) => void;

  async function withServer(proto: Proto, handler: Handler, fn: (port: number) => Promise<void>) {
    const listener = (_req: unknown, res: NodeServerResponse) => handler(res);
    const server = proto === "http/1.1" ? createServer(listener) : http2.createServer(listener);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn((server.address() as AddressInfo).port);
    } finally {
      (server as ReturnType<typeof createServer>).closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  }

  /** Sends one request and returns status, `content-length` and body text. */
  async function send(proto: Proto, port: number, method = "GET") {
    if (proto === "http/1.1") {
      const res = await fetch(`http://127.0.0.1:${port}`, { method });
      return { length: res.headers.get("content-length"), text: await res.text() };
    }
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      return await new Promise<{ length: unknown; text: string }>((resolve, reject) => {
        const req = client.request({ ":method": method, ":path": "/" });
        let length: unknown;
        let text = "";
        req.setEncoding("utf8");
        req.on("response", (h) => (length = h["content-length"]));
        req.on("data", (chunk) => (text += chunk));
        req.on("end", () => resolve({ length, text }));
        req.on("error", reject);
        req.end();
      });
    } finally {
      client.close();
    }
  }

  /**
   * Opens a request and resets it from the client side: once the server has
   * seen it (`when: "request"`), or once the first response bytes arrive
   * (`when: "data"`).
   */
  async function reset(
    proto: Proto,
    port: number,
    when: "request" | "data",
    requestSeen: Promise<unknown>,
  ) {
    if (proto === "http/1.1") {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      );
      socket.on("error", () => {});
      if (when === "data") socket.once("data", () => socket.resetAndDestroy());
      else void requestSeen.then(() => socket.resetAndDestroy());
      return () => socket.destroy();
    }
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    const req = client.request({ ":path": "/" });
    req.on("error", () => {});
    req.end();
    const cancel = () => req.close(http2.constants.NGHTTP2_CANCEL);
    if (when === "data") req.once("data", cancel);
    else void requestSeen.then(cancel);
    return () => client.destroy();
  }

  /** Whether `promise` settles within `ms` (guards against hanging the suite). */
  function settles(promise: Promise<unknown>, ms = 2000): Promise<boolean> {
    return Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
    ]);
  }

  const bodies = {
    string: () => "hello",
    Uint8Array: () => new TextEncoder().encode("hello"),
  };

  for (const proto of ["http/1.1", "http/2"] as const) {
    describe(proto, () => {
      for (const [kind, body] of Object.entries(bodies)) {
        test(`${kind} body resolves after finish`, async () => {
          let finishedOnSettle: boolean | undefined;
          const handler: Handler = (res) =>
            void sendNodeResponse(res, new FastResponse(body())).then(() => {
              finishedOnSettle = res.writableFinished;
            });
          await withServer(proto, handler, async (port) => {
            expect(await send(proto, port)).toEqual({ length: "5", text: "hello" });
            await vi.waitFor(() => expect(finishedOnSettle).toBe(true));
          });
        });
      }

      test("HEAD keeps content-length, sends no body and resolves", async () => {
        let sent: Promise<void> | undefined;
        await withServer(
          proto,
          (res) => (sent = sendNodeResponse(res, new FastResponse("hello"))),
          async (port) => {
            expect(await send(proto, port, "HEAD")).toEqual({ length: "5", text: "" });
            await vi.waitFor(() => expect(sent).toBeDefined());
            expect(await settles(sent!)).toBe(true);
          },
        );
      });

      const flushedCases = proto === "http/1.1" ? [false, true] : [false];
      for (const flushHeaders of flushedCases) {
        test(`settles when the client is gone before send${flushHeaders ? " (headers flushed)" : ""}`, async () => {
          let onSeen!: () => void;
          const requestSeen = new Promise<void>((r) => (onSeen = r));
          // Boxed: a promise resolved with a promise would adopt its state.
          let onSent!: (box: { sent: Promise<void> }) => void;
          const box = new Promise<{ sent: Promise<void> }>((r) => (onSent = r));
          const handler: Handler = (res) => {
            if (flushHeaders) {
              // Only exercised on HTTP/1.1.
              const h1Res = res as NodeHttp.ServerResponse;
              h1Res.writeHead(200, { "content-length": "5" });
              h1Res.flushHeaders();
            }
            res.once("close", () =>
              onSent({ sent: sendNodeResponse(res, new FastResponse("hello")) }),
            );
            onSeen();
          };
          await withServer(proto, handler, async (port) => {
            const cleanup = await reset(proto, port, "request", requestSeen);
            try {
              expect(await settles((await box).sent)).toBe(true);
            } finally {
              cleanup();
            }
          });
        });
      }

      test("settles when the client resets mid-body", async () => {
        const big = "a".repeat(16 * 1024 * 1024);
        let sent: Promise<void> | undefined;
        await withServer(
          proto,
          (res) => (sent = sendNodeResponse(res, new FastResponse(big))),
          async (port) => {
            const cleanup = await reset(proto, port, "data", Promise.resolve());
            try {
              await vi.waitFor(() => expect(sent).toBeDefined());
              expect(await settles(sent!)).toBe(true);
            } finally {
              cleanup();
            }
          },
        );
      });
    });
  }
});
