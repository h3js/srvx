import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

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
