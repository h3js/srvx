import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";

import type { NodeHttp1Handler, NodeServerRequest, NodeServerResponse } from "../src/types.ts";
import {
  fetchNodeHandler,
  FastResponse,
  serve,
  toNodeHandler,
  toFetchHandler,
} from "../src/adapters/node.ts";

import express from "express";
import fastify from "fastify";

const fetchCallers = [
  {
    name: "direct fetch",
    fetchNodeHandler,
  },
  {
    name: "through srvx/node",
    async fetchNodeHandler(handler: NodeHttp1Handler, req: Request) {
      const server = serve({
        port: 0,
        fetch: (webReq) => fetchNodeHandler(handler, webReq),
      });
      await server.ready();
      const reqURL = new URL(req.url);
      const originURL = new URL(server.url!);
      reqURL.port = originURL.port;
      reqURL.hostname = originURL.hostname;
      return globalThis.fetch(new Request(reqURL.toString(), req));
    },
  },
];

const fixtures: { name: string; skip?: boolean; handler: NodeHttp1Handler }[] = [
  {
    name: "node",
    handler: async (req, res) => {
      const body: any = await new Promise((resolve) => {
        const chunks: Uint8Array[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      });

      setImmediate(() => {
        res.writeHead(418, "I'm a Moka Pot", {
          "Content-Type": "application/json; charset=utf-8",
        });
        const resBody = JSON.stringify({
          header: req.headers["x-test"] === "1",
          body: body?.test === true,
        });
        res.end(new TextEncoder().encode(resBody));
      });
    },
  },
  {
    name: "express",
    handler: express()
      .use(express.json())
      .use("/", (req, res) => {
        res.statusMessage = "I'm a Moka Pot";
        res.status(418).json({
          header: req.headers["x-test"] === "1",
          body: req.body?.test === true,
        });
      }) as NodeHttp1Handler,
  },
  {
    name: "fastify",
    handler: await (async () => {
      const app = fastify();
      app.post("/", async (request, reply) => {
        reply.status(418);
        reply.raw.statusMessage = "I'm a Moka Pot";
        return {
          header: request.headers["x-test"] === "1",
          body: (request.body as any)?.test === true,
        };
      });
      await app.ready();
      return app.routing as NodeHttp1Handler;
    })(),
  },
];

describe("fetchNodeHandler", () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      for (const caller of fetchCallers) {
        test(caller.name, async () => {
          const res = await caller.fetchNodeHandler(
            fixture.handler as any,
            new Request("http://localhost/", {
              method: "POST",
              headers: {
                "x-test": "1",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ test: true }),
            }),
          );
          expect(res.status).toBe(418);
          expect(res.statusText).toBe("I'm a Moka Pot");

          expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
          // TODO: body
          expect(await res.json()).toMatchObject({ header: true, body: true });
        });
      }
    });
  }
});

describe("adapters", () => {
  function simpleNodeHandler(req: NodeServerRequest, res: NodeServerResponse) {
    // @ts-expect-error
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }

  function simpleWebHandler(): Response {
    return new Response("ok", { status: 200 });
  }

  test("toFetchHandler", async () => {
    const webHandler = toFetchHandler(simpleNodeHandler);
    expect(webHandler.__nodeHandler).toBe(simpleNodeHandler);
    expect(webHandler.name).toBe("simpleNodeHandler (converted to Web handler)");
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("toNodeHandler", async () => {
    const nodeHandler = toNodeHandler(simpleWebHandler);
    expect(nodeHandler.__fetchHandler).toBe(simpleWebHandler);
    expect(nodeHandler.name).toBe("simpleWebHandler (converted to Node handler)");

    const res = await fetchNodeHandler(nodeHandler, new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("toFetchHandler(toNodeHandler())", async () => {
    expect(toFetchHandler(toNodeHandler(simpleWebHandler))).toBe(simpleWebHandler);
  });

  test("toNodeHandler(toFetchHandler())", async () => {
    expect(toNodeHandler(toFetchHandler(simpleNodeHandler))).toBe(simpleNodeHandler);
  });

  // https://github.com/h3js/srvx/issues/208
  test("backpressure-aware handler does not deadlock", async () => {
    const backpressureHandler: NodeHttp1Handler = (_req, res) => {
      return (async () => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        // Write well past the socket highWaterMark so write() returns false and
        // the handler has to wait for a "drain" event to resume.
        for (let i = 0; i < 20; i++) {
          if (!res.write("x".repeat(5000))) {
            await new Promise<void>((resolve) => res.once("drain", () => resolve()));
          }
        }
        res.end();
      })();
    };
    const webHandler = toFetchHandler(backpressureHandler);

    const body = await Promise.race([
      Promise.resolve(webHandler(new Request("http://localhost/"))).then((r) => r.text()),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("deadlocked waiting for response")), 3000),
      ),
    ]);

    expect(body.length).toBe(20 * 5000);
  });

  // https://github.com/h3js/srvx/issues/208
  test("already-aborted request signal does not crash or hang", async () => {
    const webHandler = toFetchHandler(simpleNodeHandler);

    const controller = new AbortController();
    controller.abort();

    // Must not throw an unhandled error / crash the process, must settle, and
    // reading the body must not hang on a stream that never closes.
    const settled = await Promise.race([
      Promise.resolve(webHandler(new Request("http://localhost/", { signal: controller.signal })))
        .then((res) => res.text())
        .then(
          () => "completed",
          () => "errored",
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);

    expect(settled).not.toBe("hung");
  });

  // https://github.com/h3js/srvx/issues/208
  test("client abort mid-stream does not crash or hang", async () => {
    const controller = new AbortController();

    // Streams a chunk, then drops the client while the response is still open.
    // Exercises the asynchronous abort path (addAbortSignal -> socket.destroy
    // after construction) and the _destroy() teardown erroring an already-open
    // response body controller that has enqueued data.
    const abortHandler: NodeHttp1Handler = (_req, res) => {
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        res.on("close", done);
        res.on("error", done);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.write("partial");
        controller.abort();
      });
    };
    const webHandler = toFetchHandler(abortHandler);

    // Must settle (not hang) and must not crash the process with an unhandled
    // socket "error" event.
    const settled = await Promise.race([
      Promise.resolve(webHandler(new Request("http://localhost/", { signal: controller.signal })))
        .then((res) => res.text())
        .then(
          () => "completed",
          () => "errored",
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);

    expect(settled).not.toBe("hung");
  });

  // F13: head/body split must use the FIRST CRLFCRLF, not the last, otherwise
  // response bodies that themselves contain "\r\n\r\n" (multipart, proxied HTTP,
  // binary) get silently truncated.
  test("response body containing CRLFCRLF arrives intact", async () => {
    const payload = "before\r\n\r\nafter\r\n\r\nend";
    const bodyHandler: NodeHttp1Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(payload);
    };
    const webHandler = toFetchHandler(bodyHandler);
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
  });

  // F14: null-body statuses (204/304/...) must not throw when constructing the
  // web Response (which would surface as a 500).
  test("null-body status 204 does not become a 500", async () => {
    const handler: NodeHttp1Handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const webHandler = toFetchHandler(handler);
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("conditional-GET 304 does not become a 500", async () => {
    const handler: NodeHttp1Handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    const webHandler = toFetchHandler(handler);
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  // F15: body listeners attached after an `await` (e.g. async middleware in
  // front of express.json()) must still receive data + "end", and req.complete
  // must become true.
  test("late-attached body listeners still receive data and end", async () => {
    const handler: NodeHttp1Handler = (req, res) => {
      return (async () => {
        // Defer attaching listeners past a microtask/tick.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const chunks: Uint8Array[] = [];
        const body = await new Promise<string>((resolve) => {
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({ body, complete: req.complete }));
      })();
    };
    const webHandler = toFetchHandler(handler);
    const settled = await Promise.race([
      Promise.resolve(
        webHandler(new Request("http://localhost/", { method: "POST", body: "hello world" })),
      ).then((r) => r.json()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hung waiting for body")), 3000),
      ),
    ]);
    expect(settled).toMatchObject({ body: "hello world", complete: true });
  });

  // F16: a large upload must apply backpressure rather than buffering the whole
  // body in memory. A handler that defers reading (e.g. slow async middleware)
  // must NOT cause the source to flood the internal buffer — with the source
  // paused on `push() === false`, only about one highWaterMark of data can
  // accumulate before reading resumes. Without the fix the full upload buffers.
  test("large upload applies backpressure and arrives completely", async () => {
    const chunkSize = 64 * 1024;
    const chunk = "x".repeat(chunkSize);
    const totalChunks = 32;
    const expectedLength = chunkSize * totalChunks;

    let bufferedBeforeReading = 0;
    const handler: NodeHttp1Handler = (req, res) => {
      return (async () => {
        // Defer reading so an unthrottled source would have time to flood the
        // internal buffer with the entire upload.
        await new Promise((r) => setTimeout(r, 100));
        bufferedBeforeReading = (req as any).readableLength ?? 0;
        let received = 0;
        for await (const c of req as any) {
          received += (c as Uint8Array).length;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(received));
      })();
    };
    const webHandler = toFetchHandler(handler);

    // Fast producer: enqueue everything up front without waiting.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const data = new TextEncoder().encode(chunk);
        for (let i = 0; i < totalChunks; i++) {
          controller.enqueue(data);
        }
        controller.close();
      },
    });

    const res = await webHandler(
      new Request("http://localhost/", {
        method: "POST",
        body: source,
        // @ts-expect-error duplex is required for a stream body
        duplex: "half",
      }),
    );
    expect(res.status).toBe(200);
    // Full body arrives intact.
    expect(Number(await res.text())).toBe(expectedLength);
    // The source was throttled: far less than the full upload buffered while the
    // handler was not reading. (Without the fix this equals expectedLength.)
    expect(bufferedBeforeReading).toBeLessThan(expectedLength / 2);
  });

  // Connect-style `(req, res, next)` middleware on the synthetic bridge path
  // (no real Node req/res) must receive a working `next`. Without it, invoking
  // `next` threw ("next is not a function") and surfaced as a 500.
  test("connect-style middleware that ends the response works", async () => {
    const middleware = (
      _req: NodeServerRequest,
      res: NodeServerResponse,
      _next: (error?: Error) => void,
    ) => {
      // @ts-expect-error http1/http2 union
      res.writeHead(201, { "content-type": "text/plain" });
      res.end("middleware ok");
    };
    const webHandler = toFetchHandler(middleware as any);
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("middleware ok");
  });

  test("connect-style middleware calling next() does not 500", async () => {
    const middleware = (
      _req: NodeServerRequest,
      res: NodeServerResponse,
      next: (error?: Error) => void,
    ) => {
      res.setHeader("x-mw", "1");
      // No downstream handler: finalize with the current response state.
      next();
    };
    const webHandler = toFetchHandler(middleware as any);
    const settled = await Promise.race([
      Promise.resolve(webHandler(new Request("http://localhost/"))).then((r) => ({
        status: r.status,
        header: r.headers.get("x-mw"),
      })),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hung waiting for next()")), 3000),
      ),
    ]);
    expect(settled).toMatchObject({ status: 200, header: "1" });
  });

  test("connect-style middleware calling next(err) propagates as an error", async () => {
    const error = new Error("boom");
    const middleware = (
      _req: NodeServerRequest,
      _res: NodeServerResponse,
      next: (error?: Error) => void,
    ) => {
      next(error);
    };
    const webHandler = toFetchHandler(middleware as any);
    // Silence the expected error log from fetchNodeHandler's catch.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("connect-style middleware that throws async propagates as an error", async () => {
    const middleware = (
      _req: NodeServerRequest,
      _res: NodeServerResponse,
      _next: (error?: Error) => void,
    ) => Promise.reject(new Error("async boom"));
    const webHandler = toFetchHandler(middleware as any);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("request signal", () => {
  test("should not fire abort signal on successful GET request", async () => {
    let abortFired = false;

    const server = serve({
      port: 0,
      fetch(request) {
        request.signal.addEventListener("abort", () => {
          abortFired = true;
        });
        return new Response("ok");
      },
    });

    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Close the server and let all pending handlers flush
    await server.close();

    expect(abortFired).toBe(false);
  });

  test("should not fire abort signal on successful POST request", async () => {
    let abortFired = false;
    let receivedBody: string | undefined;

    const server = serve({
      port: 0,
      async fetch(request) {
        request.signal.addEventListener("abort", () => {
          abortFired = true;
        });
        receivedBody = await request.text();
        return new Response(`Received: ${receivedBody}`);
      },
    });

    await server.ready();

    const res = await fetch(server.url!, {
      method: "POST",
      body: "test body",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Received: test body");
    expect(receivedBody).toBe("test body");

    await server.close();

    expect(abortFired).toBe(false);
  });

  test("should fire abort signal when client disconnects", async () => {
    let abortFired: () => void;
    const abortFiredPromise = new Promise<void>((resolve) => {
      abortFired = resolve;
    });

    let requestReceived: () => void;
    const requestReceivedPromise = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });

    const server = serve({
      port: 0,
      fetch(request) {
        request.signal.addEventListener("abort", () => {
          abortFired();
        });
        requestReceived();

        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (request.signal.aborted) {
                controller.close();
                return;
              }
              await new Promise((r) => setTimeout(r, 100));
              controller.enqueue(new TextEncoder().encode("data"));
            },
          }),
        );
      },
    });

    await server.ready();

    const controller = new AbortController();
    const fetchPromise = fetch(server.url!, { signal: controller.signal });

    await requestReceivedPromise;
    controller.abort();

    // Wait for both client rejection and server-side abort
    await fetchPromise.catch(() => {});
    await Promise.race([
      abortFiredPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Abort signal not fired within 1s")), 1000),
      ),
    ]);

    await server.close(true); // Force close all connections
  });
});

describe("node server startup", () => {
  async function withBlockedPort(fn: (port: number) => Promise<void>) {
    const blocker = createServer((_req, res) => res.end("blocked"));
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.once("listening", () => resolve());
      blocker.listen(0, "127.0.0.1");
    });
    const { port } = blocker.address() as AddressInfo;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }

  test("port conflict rejects with EADDRINUSE", async () => {
    await withBlockedPort(async (port) => {
      const server = serve({
        port,
        hostname: "127.0.0.1",
        manual: true,
        fetch: () => new Response(""),
      });
      await expect(server.serve()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await server.close();
    });
  });

  test("auto-serve port conflict surfaces via ready()", async () => {
    await withBlockedPort(async (port) => {
      const server = serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response(""),
      });
      await expect(server.ready()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await server.close();
    });
  });

  // close() must reset the internal listening state so a subsequent serve()
  // actually re-invokes server.listen() instead of returning the stale,
  // already-resolved promise (which left the server permanently down).
  test("server can be restarted with serve() after close()", async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });

    await server.ready();
    const res1 = await fetch(server.url!);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("ok");

    await server.close();

    // Restart on a fresh listen (port 0 -> new random port).
    await server.serve();
    await server.ready();
    const res2 = await fetch(server.url!);
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe("ok");

    await server.close();
  });

  // In manual mode ready() must not resolve until serve() has been called and
  // the server is actually listening (previously it resolved immediately
  // because #listeningPromise was still undefined).
  test("ready() waits for serve() in manual mode", async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      manual: true,
      fetch: () => new Response("ok"),
    });

    let readyResolved = false;
    const readyPromise = server.ready().then(() => {
      readyResolved = true;
    });

    // Give ready() the chance to (incorrectly) resolve before serve() is called.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readyResolved).toBe(false);
    expect(server.url).toBeUndefined();

    await server.serve();
    await readyPromise;
    expect(readyResolved).toBe(true);
    expect(server.url).toBeTruthy();

    const res = await fetch(server.url!);
    expect(await res.text()).toBe("ok");

    await server.close();
  });
});

describe("reusePort", () => {
  test("maps reusePort to the SO_REUSEPORT listen option", () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      reusePort: true,
      manual: true,
      fetch: () => new Response(""),
    });
    const serveOptions = (server as { serveOptions?: Record<string, unknown> }).serveOptions;
    expect(serveOptions).toMatchObject({ reusePort: true, exclusive: false });
  });

  // SO_REUSEPORT is only supported on Linux (and a few BSDs) with Node >= 22.12.
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported =
    !globalThis.Deno &&
    !globalThis.Bun &&
    process.platform === "linux" &&
    (major > 22 || (major === 22 && minor >= 12));

  test.skipIf(!supported)("two servers can bind the same port with reusePort", async () => {
    // Reserve then release a free port to reuse across both servers.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const makeServer = () =>
      serve({
        port,
        hostname: "127.0.0.1",
        reusePort: true,
        manual: true,
        fetch: () => new Response("ok"),
      });

    const a = makeServer();
    const b = makeServer();
    try {
      // Without reusePort, the second listen() on the same port would EADDRINUSE.
      await a.serve();
      await b.serve();
      expect(new URL(a.url!).port).toBe(String(port));
      expect(new URL(b.url!).port).toBe(String(port));
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("FastResponse header dedup", () => {
  // `_toNodeResponse().headers` is a flat rawHeaders-style list; header names
  // are normalized to lowercase (matching native Response semantics).
  const headerPairs = (headers: string[]) => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < headers.length; i += 2) {
      pairs.push([headers[i], headers[i + 1]]);
    }
    return pairs;
  };
  const contentLengthEntries = (headers: string[]) =>
    headerPairs(headers).filter(([key]) => key === "content-length");
  const contentTypeEntries = (headers: string[]) =>
    headerPairs(headers).filter(([key]) => key === "content-type");

  test("does not duplicate capitalized array-form Content-Length", () => {
    const { headers } = new FastResponse("hello", {
      headers: [["Content-Length", "999"]],
    })._toNodeResponse();
    const cl = contentLengthEntries(headers);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toEqual(["content-length", "999"]);
  });

  test("does not duplicate capitalized array-form Content-Type", () => {
    const { headers } = new FastResponse("hello", {
      headers: [["Content-Type", "text/html"]],
    })._toNodeResponse();
    const ct = contentTypeEntries(headers);
    expect(ct).toHaveLength(1);
    expect(ct[0]).toEqual(["content-type", "text/html"]);
  });

  test("lowercase array-form Content-Length still dedups", () => {
    const { headers } = new FastResponse("hello", {
      headers: [["content-length", "999"]],
    })._toNodeResponse();
    const cl = contentLengthEntries(headers);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toEqual(["content-length", "999"]);
  });

  test("auto-computes Content-Length when user provides none", () => {
    const { headers } = new FastResponse("hello", {
      headers: [["X-Custom", "1"]],
    })._toNodeResponse();
    const cl = contentLengthEntries(headers);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toEqual(["content-length", "5"]);
  });
});

// v1 stabilization: Node-adapter crash/corruption regressions.
describe("node body crash regressions", () => {
  // F1: the non-middleware branch of callNodeHandler had no `.catch`, so an async
  // node handler that threw caused an unhandledRejection AND never settled (the
  // request hung). It must reject like the middleware branch.
  test("F1: async node handler that throws does not crash or hang", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);

    const throwingHandler: NodeHttp1Handler = async () => {
      throw new Error("boom");
    };

    const server = serve({
      port: 0,
      // Surface the callNodeHandler rejection as a clean 500 so we can assert it
      // settled instead of hanging.
      error: () => new Response("caught", { status: 500 }),
      fetch: (webReq) => fetchNodeHandler(throwingHandler, webReq),
    });
    await server.ready();

    try {
      const res = await Promise.race([
        fetch(server.url!),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("request hung")), 3000),
        ),
      ]);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("caught");
      // Let any (buggy) unhandledRejection flush before asserting the process survived.
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      await server.close(true);
    }
  });

  // F2: after the buffered fast path consumes the IncomingMessage, a second
  // text()/json() re-attached data/end listeners to an ended stream and hung.
  // It must reject with `TypeError: Body is unusable`.
  test("F2: second body read rejects with TypeError instead of hanging", async () => {
    let firstRead: string | undefined;
    let secondReadOutcome: string | undefined;

    const server = serve({
      port: 0,
      async fetch(req) {
        firstRead = await req.text();
        secondReadOutcome = await Promise.race([
          req.text().then(
            () => "resolved",
            (error) => (error instanceof TypeError ? "TypeError" : "other-error"),
          ),
          new Promise<string>((r) => setTimeout(() => r("hung"), 2000)),
        ]);
        return new Response("ok");
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(firstRead).toBe("hello");
    expect(secondReadOutcome).toBe("TypeError");
    await server.close(true);
  });

  // F3: the `_request` getter wrapped the already-consumed stream in a native
  // Request, throwing "... disturbed or locked" synchronously and poisoning
  // bodyUsed / clone() / mode. These must all work after consumption.
  test("F3: bodyUsed / clone() / mode work after body consumption", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const bodyUsedBefore = req.bodyUsed;
        const text = await req.text();
        const bodyUsedAfter = req.bodyUsed;

        let cloneOk = true;
        try {
          req.clone();
        } catch {
          cloneOk = false;
        }

        let mode: string;
        try {
          mode = req.mode;
        } catch {
          mode = "THREW";
        }

        return Response.json({ text, bodyUsedBefore, bodyUsedAfter, cloneOk, mode });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      text: "hello",
      bodyUsedBefore: false,
      bodyUsedAfter: true,
      cloneOk: true,
      mode: "cors",
    });
    await server.close(true);
  });

  // https://github.com/h3js/srvx/issues/247
  // Only text()/json() guarded against a second read. The rest of the body
  // methods are inherited from the native Request, which `_request` hands a
  // *null* body once srvx has consumed the real one — so undici's own guard saw
  // a pristine body and they resolved empty, silently masking double-read bugs
  // that throw on every other runtime.
  test("every body method rejects after the body is consumed", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        await req.text();
        const outcomes: Record<string, string> = { bodyUsed: String(req.bodyUsed) };
        for (const method of [
          "arrayBuffer",
          "bytes",
          "blob",
          "formData",
          "text",
          "json",
        ] as const) {
          outcomes[method] = await (req[method]() as Promise<unknown>).then(
            () => "resolved",
            (error) =>
              error instanceof TypeError && /unusable/.test(error.message)
                ? "TypeError: unusable"
                : `other: ${error}`,
          );
        }
        return Response.json(outcomes);
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({
      bodyUsed: "true",
      arrayBuffer: "TypeError: unusable",
      bytes: "TypeError: unusable",
      blob: "TypeError: unusable",
      formData: "TypeError: unusable",
      text: "TypeError: unusable",
      json: "TypeError: unusable",
    });
    await server.close(true);
  });

  // https://github.com/h3js/srvx/issues/247 (related)
  // Draining `req.body` never flipped `bodyUsed`, so a later read still looked
  // like a first read: it reached the `_request` getter, which threw
  // "... disturbed or locked" *synchronously* out of the handler.
  test("streaming the body directly marks it used and rejects later reads", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        let streamed = "";
        for await (const chunk of req.body!) {
          streamed += new TextDecoder().decode(chunk as Uint8Array);
        }
        return Response.json({
          streamed,
          bodyUsed: req.bodyUsed,
          arrayBuffer: await req.arrayBuffer().then(
            () => "resolved",
            (error) => (error instanceof TypeError ? "TypeError" : `other: ${error}`),
          ),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({
      streamed: "hello",
      bodyUsed: true,
      arrayBuffer: "TypeError",
    });
    await server.close(true);
  });

  // The flip side of the above: `bodyUsed` tracks the spec's "disturbed" bit, so
  // merely *touching* `request.body` must not consume it — `isDisturbed` on the
  // handed-out stream must stay false until an actual read or cancel.
  test("accessing req.body without reading it does not mark the body used", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const hasBody = req.body !== null;
        const bodyUsed = req.bodyUsed;
        // The body is undisturbed, so a buffered read must still work.
        return Response.json({ hasBody, bodyUsed, text: await req.text() });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({ hasBody: true, bodyUsed: false, text: "hello" });
    await server.close(true);
  });

  // Cancelling the body disturbs it per the fetch spec, exactly like reading it:
  // `bodyUsed` flips and later reads reject.
  test("cancelling req.body marks the body used and rejects later reads", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        await req.body!.cancel();
        return Response.json({
          bodyUsed: req.bodyUsed,
          text: await req.text().then(
            () => "resolved",
            (error) => (error instanceof TypeError ? "TypeError" : `other: ${error}`),
          ),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({ bodyUsed: true, text: "TypeError" });
    await server.close(true);
  });

  // `clone()` tees the body, so reading the clone must leave the original
  // readable — the "disturbed" tracking on the underlying stream must not
  // mistake a pull driven by the clone for a read of this request's body.
  test("reading a clone leaves the original body readable", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const fromClone = await req.clone().text();
        return Response.json({
          fromClone,
          fromOriginal: await req.text().then(
            (text) => `resolved(${text})`,
            (error) => `${error}`,
          ),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({ fromClone: "hello", fromOriginal: "resolved(hello)" });
    await server.close(true);
  });

  // The native Request owns the accounting once it holds the real body: a first
  // arrayBuffer() must read it, and only the second read rejects.
  test("arrayBuffer() reads the body once and rejects on a second read", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const first = new TextDecoder().decode(await req.arrayBuffer());
        return Response.json({
          first,
          bodyUsed: req.bodyUsed,
          second: await req.arrayBuffer().then(
            () => "resolved",
            (error) => (error instanceof TypeError ? "TypeError" : `other: ${error}`),
          ),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({ first: "hello", bodyUsed: true, second: "TypeError" });
    await server.close(true);
  });

  // GET/HEAD are always null-body per the fetch spec, regardless of what was on
  // the wire and regardless of property-access order.
  for (const order of ["text-first", "body-first"] as const) {
    test(`GET with a body on the wire is null-body (${order})`, async () => {
      const server = serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const result: Record<string, unknown> = {};
          if (order === "body-first") {
            result.bodyNull = req.body === null;
            result.text = await req.text();
          } else {
            result.text = await req.text();
            result.bodyNull = req.body === null;
          }
          // FastResponse with a string body is content-length framed, which the
          // raw parser below relies on.
          return new FastResponse(JSON.stringify(result));
        },
      });
      await server.ready();

      // Send a GET with a body on the wire via a raw socket (fetch forbids it).
      const u = new URL(server.url!);
      const raw = await rawExchange(
        Number(u.port),
        u.hostname,
        "GET / HTTP/1.1\r\n" +
          `Host: ${u.hostname}\r\n` +
          "Content-Length: 5\r\n" +
          "Connection: close\r\n" +
          "\r\n" +
          "hello",
      );
      const responses = parseHttpResponses(raw);
      expect(responses).toHaveLength(1);
      expect(JSON.parse(responses[0].body.toString())).toEqual({ bodyNull: true, text: "" });
      await server.close(true);
    });
  }

  // F5: a TypedArray/DataView view of a larger buffer must send only the view's
  // window. `Buffer.from(view.buffer)` sent the whole ArrayBuffer while
  // content-length was the view length — wrong bytes out, stray bytes left in the
  // keep-alive connection (corrupting the next pipelined response).
  test("F5: DataView view body sends exact bytes and keeps the connection clean", async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/view") {
          // 4-byte view (values 3,4,5,6) of a 10-byte buffer.
          const buffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
          const view = new DataView(buffer, 3, 4);
          return new FastResponse(view);
        }
        return new FastResponse("second");
      },
    });
    await server.ready();

    const u = new URL(server.url!);
    // Two pipelined keep-alive requests on one socket; the second closes it.
    const raw = await rawExchange(
      Number(u.port),
      u.hostname,
      `GET /view HTTP/1.1\r\nHost: ${u.hostname}\r\n\r\n` +
        `GET /second HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\n\r\n`,
    );

    const responses = parseHttpResponses(raw);
    expect(responses).toHaveLength(2);
    expect([...responses[0].body]).toEqual([3, 4, 5, 6]);
    expect(responses[1].body.toString()).toBe("second");
    await server.close(true);
  });
});

// Regressions where the Node adapter diverged from native fetch semantics
// (Response defaults, HEAD handling, send diagnostics, node-compat bridge).
describe("node fetch-spec correctness regressions", () => {
  const headerPairs = (headers: string[]) => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < headers.length; i += 2) {
      pairs.push([headers[i], headers[i + 1]]);
    }
    return pairs;
  };

  // A streaming body for a HEAD request must be cancelled immediately, not
  // pumped to completion (an unbounded SSE stream would pump forever).
  test("HEAD cancels a streaming body instead of pumping it", async () => {
    let cancelled = false;
    let pulls = 0;
    const server = serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("data\n"));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream);
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    // Let the cancellation settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
    // The stream was cancelled up front rather than pumped.
    expect(pulls).toBeLessThanOrEqual(1);
    await server.close(true);
  });

  // statusText defaults to the spec's empty reason phrase, not Node's phrase.
  test("statusText defaults to empty string, not Node's reason phrase", () => {
    expect(new FastResponse("x", { status: 200 }).statusText).toBe("");
    expect(new FastResponse("x", { status: 404 }).statusText).toBe("");
    expect(new FastResponse("x", { status: 200, statusText: "Custom" }).statusText).toBe("Custom");
  });

  // An empty-string body still gets the implicit text content-type + length 0,
  // matching native Response("").
  test("empty-string body keeps default content-type and content-length", () => {
    const { headers } = new FastResponse("")._toNodeResponse();
    const pairs = headerPairs(headers);
    expect(pairs).toContainEqual(["content-type", "text/plain; charset=UTF-8"]);
    expect(pairs).toContainEqual(["content-length", "0"]);

    // Sanity: a native Response agrees on the content-type.
    expect(new Response("").headers.get("content-type")).toBe("text/plain;charset=UTF-8");
  });

  // text()/json() on a locked/disturbed body stream must reject, not throw
  // synchronously.
  test("text() on a locked body stream rejects instead of throwing", async () => {
    let outcome = "unset";
    const server = serve({
      port: 0,
      async fetch(req) {
        // Disturb the body stream directly (bypassing srvx's own bodyUsed
        // tracking) so text() hits the `new Response(stream)` path with a
        // locked/disturbed stream.
        const reader = req.body!.getReader();
        await reader.cancel();
        outcome = await req.text().then(
          () => "resolved",
          (error) => (error instanceof TypeError ? "TypeError" : "other-error"),
        );
        return new Response(outcome);
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "hello" });
    expect(await res.text()).toBe("TypeError");
    await server.close(true);
  });

  // A synchronous send failure (e.g. an invalid header value hitting writeHead)
  // must be logged for diagnostics (unless silenced) and returned as a bare 500
  // without leaking details to the client.
  test("send error is logged and returns a bare 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = serve({
      port: 0,
      fetch() {
        // An invalid header value throws synchronously inside writeHead().
        return new FastResponse("body", { headers: [["x-bad", "bad\r\ninjected"]] });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(""); // no error detail leaked to the client
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    await server.close(true);
  });

  test("send error is not logged when the server is silent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = serve({
      port: 0,
      silent: true,
      fetch() {
        return new FastResponse("body", { headers: [["x-bad", "bad\r\ninjected"]] });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    await server.close(true);
  });

  // The synthetic IncomingMessage built for the web->node bridge must expose
  // httpVersion / rawHeaders (morgan's :http-version, keep-alive logic).
  test("synthetic IncomingMessage exposes httpVersion and rawHeaders", async () => {
    const handler: NodeHttp1Handler = (req, res) => {
      const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "x-test");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          httpVersion: req.httpVersion,
          major: req.httpVersionMajor,
          minor: req.httpVersionMinor,
          rawXTestValue: idx === -1 ? null : req.rawHeaders[idx + 1],
        }),
      );
    };

    const res = await fetchNodeHandler(
      handler,
      new Request("http://localhost/", { headers: { "x-test": "abc" } }),
    );
    expect(await res.json()).toMatchObject({
      httpVersion: "1.1",
      major: 1,
      minor: 1,
      rawXTestValue: "abc",
    });
  });
});

// Raw HTTP/1.1 helpers: write `payload`, collect every byte until the server
// closes the connection (driven by a `Connection: close` on the last request).
function rawExchange(port: number, host: string, payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", () => socket.write(payload));
    setTimeout(() => {
      socket.destroy();
      reject(new Error("rawExchange timed out"));
    }, 3000).unref?.();
  });
}

// Minimal content-length-framed response parser (sufficient for these fixtures).
function parseHttpResponses(buf: Buffer): { headers: string; body: Buffer }[] {
  const responses: { headers: string; body: Buffer }[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const headerEnd = buf.indexOf("\r\n\r\n", offset);
    if (headerEnd === -1) break;
    const headers = buf.toString("latin1", offset, headerEnd);
    const clMatch = /content-length:\s*(\d+)/i.exec(headers);
    const bodyStart = headerEnd + 4;
    const len = clMatch ? Number(clMatch[1]) : 0;
    responses.push({ headers, body: buf.subarray(bodyStart, bodyStart + len) });
    offset = bodyStart + len;
  }
  return responses;
}
