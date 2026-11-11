import { createServer } from "node:http";
import { Readable } from "node:stream";
import { connect, type AddressInfo } from "node:net";
import http2 from "node:http2";
import { describe, expect, test, vi } from "vitest";
import { getTLSCert, HOST_PARSER_AGREEMENT_CASES } from "./_utils.ts";
import { isValidHost } from "../src/_trust-proxy.ts";

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

// Deno's node-compat HTTP layer poisons reused keep-alive connections and
// mishandles some streaming/error paths when srvx's Node adapter is driven over
// a real socket. These cases pass on Node and Bun; skip them on Deno until
// upstream stabilises. Tracked against the `tests_deno_node_adapters` CI job.
const isDeno = !!(globalThis as any).Deno;
const isBun = !!(globalThis as any).Bun;

// HTTP/2 is not implemented in the Deno/Bun node-compat layers.
// https://github.com/h3js/srvx/issues/237
const skipHttp2 = isDeno || isBun;

// Bun's `node:http` `ServerResponse` is inert unless it is servicing a live
// request from a real Bun server: constructed standalone and handed a socket via
// `assignSocket()`, `res.end()` writes nothing at all -- `_header` stays
// `undefined` and `headersSent` stays `false`. srvx's web fetch bridge works by
// splitting the raw `HTTP/1.1 ...` head block Node writes to that socket, so
// `toFetchHandler()` / `fetchNodeHandler()` called outside a request never
// produces a response and every read of it hangs. Driven from *inside* a live
// server the same bridge does work, which is why the "through srvx/node" caller
// below still runs on Bun. Tracked against the `tests_bun` CI job.
const noBridge = isBun;

// Bun's node-compat surface differs from Node's in ways these cases assert on
// directly: a client disconnect never aborts the request, a disturbed
// `ReadableStream` does not flip `bodyUsed` (Bun raises "ReadableStream has
// already been used" instead of a `TypeError`), and `new Response("")` carries no
// default content-type. Runtime gaps rather than srvx behavior.
const noBunCompat = isBun;

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
        // Deno: the "through srvx/node" caller fetches over a real socket and
        // trips Deno's node-compat keep-alive body-read bug (passes on Node/Bun).
        // Bun: the mirror image -- only "direct fetch" drives the bridge outside a
        // live request, the one shape Bun cannot serve (see `noBridge`).
        const skip =
          (isDeno && caller.name === "through srvx/node") ||
          (noBridge && caller.name === "direct fetch");
        test.skipIf(skip)(caller.name, async () => {
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

  test.skipIf(noBridge)("toFetchHandler", async () => {
    const webHandler = toFetchHandler(simpleNodeHandler);
    expect(webHandler.__nodeHandler).toBe(simpleNodeHandler);
    expect(webHandler.name).toBe("simpleNodeHandler (converted to Web handler)");
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test.skipIf(noBridge)("toNodeHandler", async () => {
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

  // See `hasBackslashInPath`. Bun/Deno parse the request line themselves.
  test.skipIf(isDeno || isBun)("toNodeHandler rejects a raw backslash in the path", async () => {
    // Explicit content-length so the raw response body can be compared exactly.
    const webHandler = (request: Request) => {
      const { pathname } = new URL(request.url);
      return new Response(pathname, { headers: { "content-length": String(pathname.length) } });
    };
    const nodeHandler = toNodeHandler(webHandler) as NodeHttp1Handler;
    const plain = createServer(nodeHandler);
    // Mounted under express: `/public/` matches the raw target and the mounted
    // `req.url` becomes `/\..\admin/secret`, which resolves to `/admin/secret`.
    const mounted = createServer(express().use("/public", nodeHandler));
    const send = async (server: ReturnType<typeof createServer>, target: string) => {
      const { port } = server.address() as AddressInfo;
      const raw = await rawExchange(
        port,
        "127.0.0.1",
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      const text = raw.toString("latin1");
      return { status: Number(text.split(" ")[1]), body: text.split("\r\n\r\n")[1] ?? "" };
    };
    try {
      await Promise.all(
        [plain, mounted].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))),
      );
      expect((await send(plain, String.raw`/public\..\admin/secret`)).status).toBe(400);
      expect((await send(mounted, String.raw`/public/\..\admin/secret`)).status).toBe(400);
      // Accepted: encoded `%5C`, `\` in the query, and a normal mounted path.
      for (const [server, target, pathname] of [
        [plain, "/a%5Cb", "/a%5Cb"],
        [plain, String.raw`/x?q=\a`, "/x"],
        [mounted, "/public/x", "/x"],
      ] as const) {
        const res = await send(server, target);
        expect(res.status, target).toBe(200);
        expect(res.body, target).toBe(pathname);
      }
    } finally {
      plain.close();
      mounted.close();
    }
  });

  // https://github.com/h3js/srvx/issues/208
  test.skipIf(noBridge)("backpressure-aware handler does not deadlock", async () => {
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

  test.skipIf(noBridge)("request without a signal is handled", async () => {
    const req = new Request("http://localhost/", { method: "POST", body: "ping" });
    // Shadow the prototype `signal` getter with an own `undefined` property,
    // keeping the rest of the Request (headers, body) intact.
    Object.defineProperty(req, "signal", { value: undefined, configurable: true });
    expect(req.signal).toBeUndefined();

    // Echoes the request body so the socket's readable side is exercised too.
    const echoHandler: NodeHttp1Handler = (nodeReq, nodeRes) => {
      const chunks: Buffer[] = [];
      nodeReq.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      nodeReq.on("end", () => {
        nodeRes.writeHead(200, { "content-type": "text/plain" });
        nodeRes.end(Buffer.concat(chunks));
      });
    };

    const res = await fetchNodeHandler(echoHandler, req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ping");
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
  test.skipIf(noBridge)("response body containing CRLFCRLF arrives intact", async () => {
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

  // https://github.com/h3js/srvx/issues/248
  // A streaming/SSE handler that writes the head + a chunk but never calls
  // res.end() must NOT block the returned Response: toWebResponse() has to settle
  // once the head is known so the body streams incrementally instead of buffering
  // until finish (which, for open-ended SSE, never happens).
  test.skipIf(noBridge)("streaming response is returned before res.end()", async () => {
    let pushChunk!: () => void;
    let endStream!: () => void;
    const sseHandler: NodeHttp1Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      let n = 2;
      pushChunk = () => res.write(`data: ${n++}\n\n`);
      endStream = () => res.end();
      // Intentionally never returns end(); the response stays open.
    };
    const webHandler = toFetchHandler(sseHandler);

    // The Response must resolve without the handler ever calling res.end().
    const res = await Promise.race([
      Promise.resolve(webHandler(new Request("http://localhost/"))),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("streaming response hung until finish")), 3000),
      ),
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // And the body must flow chunk-by-chunk while the handler keeps writing.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);

    expect(await read()).toBe("data: 1\n\n");
    pushChunk();
    expect(await read()).toBe("data: 2\n\n");
    pushChunk();
    expect(await read()).toBe("data: 3\n\n");
    endStream();
    expect((await reader.read()).done).toBe(true);
  });

  // https://github.com/h3js/srvx/issues/248
  // An explicit `Transfer-Encoding: chunked` must not chunk-frame the bridged
  // body. The synthetic response is close-delimited (its raw bytes are captured
  // and re-wrapped in a web Response), so framing would surface as literal chunk
  // metadata in the body ("5\r\nhello\r\n...") and leak a hop-by-hop header.
  describe("explicit Transfer-Encoding: chunked does not corrupt the body", () => {
    const cases: { name: string; setHeaders: (res: any) => void }[] = [
      {
        name: "writeHead object form",
        setHeaders: (res) => res.writeHead(200, { "transfer-encoding": "chunked" }),
      },
      {
        name: "writeHead with statusMessage",
        setHeaders: (res) => res.writeHead(200, "OK", { "Transfer-Encoding": "chunked" }),
      },
      {
        name: "writeHead with a non-string statusMessage",
        setHeaders: (res) => res.writeHead(200, undefined, { "Transfer-Encoding": "chunked" }),
      },
      {
        name: "writeHead flat array form",
        setHeaders: (res) => res.writeHead(200, ["transfer-encoding", "chunked"] as any),
      },
      {
        name: "writeHead nested array form",
        setHeaders: (res) => res.writeHead(200, [["transfer-encoding", "chunked"]] as any),
      },
      {
        name: "setHeader",
        setHeaders: (res) => res.setHeader("Transfer-Encoding", "chunked"),
      },
    ];

    for (const { name, setHeaders } of cases) {
      test.skipIf(noBridge)(name, async () => {
        const handler: NodeHttp1Handler = (_req, res) => {
          setHeaders(res as any);
          res.write("hello");
          res.end("world");
        };
        const webHandler = toFetchHandler(handler);
        const res = await webHandler(new Request("http://localhost/"));
        expect(res.status).toBe(200);
        // Body arrives verbatim, without chunk framing.
        expect(await res.text()).toBe("helloworld");
        // The hop-by-hop framing header does not leak into the web Response.
        expect(res.headers.get("transfer-encoding")).toBe(null);
      });
    }
  });

  // `writeHead()` has two overloads and Node picks between them with
  // `obj ??= reason`: the headers argument is whichever of the last two is
  // present, and the third wins when both are. A reason phrase that is not a
  // string (`undefined`/`null`) therefore still leaves real headers in the third
  // argument -- what proxying an HTTP/2 upstream, which carries no status
  // message, produces. Dropping them would silently strip response headers the
  // handler set, including security ones like CSP.
  describe("writeHead forwards headers for every argument form", () => {
    const cases: { name: string; setHeaders: (res: any) => void }[] = [
      {
        name: "2-arg object form",
        setHeaders: (res) => res.writeHead(200, { "x-frame-options": "DENY" }),
      },
      {
        name: "3-arg with a string statusMessage",
        setHeaders: (res) => res.writeHead(200, "OK", { "x-frame-options": "DENY" }),
      },
      {
        name: "3-arg with an undefined statusMessage",
        setHeaders: (res) => res.writeHead(200, undefined, { "x-frame-options": "DENY" }),
      },
      {
        name: "3-arg with a null statusMessage",
        setHeaders: (res) => res.writeHead(200, null, { "x-frame-options": "DENY" }),
      },
      {
        name: "3-arg flat array form",
        setHeaders: (res) => res.writeHead(200, undefined, ["x-frame-options", "DENY"]),
      },
      {
        name: "3-arg nested array form",
        setHeaders: (res) => res.writeHead(200, undefined, [["x-frame-options", "DENY"]]),
      },
    ];

    for (const { name, setHeaders } of cases) {
      test.skipIf(noBridge)(name, async () => {
        const handler: NodeHttp1Handler = (_req, res) => {
          setHeaders(res as any);
          res.end("hello");
        };
        const res = await toFetchHandler(handler)(new Request("http://localhost/"));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      });
    }

    // Node prefers the third argument when both could be headers; mirror it so
    // the bridge and a plain `http.Server` cannot disagree on which one applies.
    test.skipIf(noBridge)("the third argument wins over a non-string second one", async () => {
      const handler: NodeHttp1Handler = (_req, res) => {
        (res as any).writeHead(200, { "x-from": "reason" }, { "x-from": "obj" });
        res.end("hello");
      };
      const res = await toFetchHandler(handler)(new Request("http://localhost/"));
      expect(res.headers.get("x-from")).toBe("obj");
      expect(await res.text()).toBe("hello");
    });
  });

  // https://github.com/h3js/srvx/issues/248
  // Hop-by-hop headers (RFC 9110 §7.6.1) describe a single transport hop, not
  // the message. Node auto-generates `Connection` on the synthetic wire and a
  // handler may set any of them explicitly; none may leak into the web Response
  // that `toWebResponse()` synthesizes.
  describe("hop-by-hop headers do not leak into the web Response", () => {
    test.skipIf(noBridge)("auto-generated Connection: close is stripped", async () => {
      const handler: NodeHttp1Handler = (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
      };
      const res = await toFetchHandler(handler)(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
      expect(res.headers.get("connection")).toBe(null);
      // End-to-end headers are untouched.
      expect(res.headers.get("content-type")).toBe("text/plain");
    });

    const hopByHop: [string, string][] = [
      ["connection", "keep-alive"],
      ["keep-alive", "timeout=5"],
      ["proxy-authenticate", "Basic"],
      ["proxy-authorization", "Basic abc"],
      ["te", "trailers"],
      ["transfer-encoding", "chunked"],
      ["upgrade", "h2c"],
    ];
    for (const [name, value] of hopByHop) {
      test.skipIf(noBridge)(`explicit ${name} is stripped`, async () => {
        const handler: NodeHttp1Handler = (_req, res) => {
          res.writeHead(200, { [name]: value, "content-type": "text/plain" });
          res.end("hello");
        };
        const res = await toFetchHandler(handler)(new Request("http://localhost/"));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello");
        expect(res.headers.get(name)).toBe(null);
        expect(res.headers.get("content-type")).toBe("text/plain");
      });
    }

    // Any field-name listed in `Connection` is itself hop-by-hop and must go too.
    test.skipIf(noBridge)("field-names listed in Connection are stripped", async () => {
      const handler: NodeHttp1Handler = (_req, res) => {
        res.writeHead(200, {
          connection: "close, x-secret",
          "x-secret": "leak",
          "content-type": "text/plain",
        });
        res.end("hello");
      };
      const res = await toFetchHandler(handler)(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("connection")).toBe(null);
      expect(res.headers.get("x-secret")).toBe(null);
      expect(res.headers.get("content-type")).toBe("text/plain");
    });
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
  test.skipIf(noBridge)("late-attached body listeners still receive data and end", async () => {
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
  test.skipIf(noBridge)("large upload applies backpressure and arrives completely", async () => {
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
  test.skipIf(noBridge)("connect-style middleware that ends the response works", async () => {
    const middleware = (
      _req: NodeServerRequest,
      res: NodeServerResponse,
      _next: (error?: Error) => void,
    ) => {
      // @ts-expect-error http1/http2 union
      res.writeHead(201, { "content-type": "text/plain" });
      res.end("middleware ok");
    };
    const webHandler = toFetchHandler(middleware);
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("middleware ok");
  });

  test.skipIf(noBridge)("connect-style middleware calling next() does not 500", async () => {
    const middleware = (
      _req: NodeServerRequest,
      res: NodeServerResponse,
      next: (error?: Error) => void,
    ) => {
      res.setHeader("x-mw", "1");
      // No downstream handler: finalize with the current response state.
      next();
    };
    const webHandler = toFetchHandler(middleware);
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
    const webHandler = toFetchHandler(middleware);
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
    const webHandler = toFetchHandler(middleware);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // `node:http` calls the round-tripped middleware without `next`, so it gets one
  // where `next()` answers 404 and `next(err)` 500, while an Express app comes back
  // as is and answers with its own final handler (an Express router has none, so it
  // gets the same `next` as middleware); Express passes its own `next`, which must
  // reach the next route.
  test("toNodeHandler(toFetchHandler()) with connect-style middleware", async () => {
    const middleware = (
      req: NodeServerRequest,
      res: NodeServerResponse,
      next: (error?: Error) => void,
    ) => {
      if (req.url === "/self") {
        // @ts-expect-error http1/http2 union
        res.writeHead(201, { "content-type": "text/plain" });
        return res.end("middleware ok");
      }
      res.setHeader("x-mw", "1");
      next(req.url === "/error" ? new Error("boom") : undefined);
    };
    expect(toNodeHandler(toFetchHandler(middleware)).name).toBe(middleware.name);
    const server = createServer(toNodeHandler(toFetchHandler(middleware)) as NodeHttp1Handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const self = await fetch(`${url}/self`);
    expect(self.status).toBe(201);
    expect(await self.text()).toBe("middleware ok");

    const next = await fetch(`${url}/next`);
    expect(next.status).toBe(404);
    expect(next.headers.get("x-mw")).toBe("1");

    const error = await fetch(`${url}/error`);
    expect(error.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const helloApp = express()
      .get("/hello", (req, res) => res.send("hello"))
      .get("/invalid", (req, res) => {
        res.status(400);
        throw new Error("invalid");
      });
    expect(toNodeHandler(toFetchHandler(helloApp))).toBe(helloApp);
    const helloServer = createServer(toNodeHandler(toFetchHandler(helloApp)) as NodeHttp1Handler);
    await new Promise<void>((resolve) => helloServer.listen(0, resolve));
    const helloUrl = `http://localhost:${(helloServer.address() as AddressInfo).port}`;

    const hello = await fetch(`${helloUrl}/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.text()).toBe("hello");
    expect((await fetch(`${helloUrl}/invalid`)).status).toBe(400);
    expect((await fetch(`${helloUrl}/missing`)).status).toBe(404);

    await new Promise<void>((resolve) => helloServer.close(() => resolve()));

    const router = express.Router().get("/route", (req, res) => res.end("route"));
    // A router's Express-typed `req` fails the types, but untyped code converts one too.
    const routerServer = createServer(
      toNodeHandler(toFetchHandler(router as any)) as NodeHttp1Handler,
    );
    await new Promise<void>((resolve) => routerServer.listen(0, resolve));
    const routerUrl = `http://localhost:${(routerServer.address() as AddressInfo).port}`;

    const route = await fetch(`${routerUrl}/route`, { signal: AbortSignal.timeout(3000) });
    expect(await route.text()).toBe("route");
    const routeMissing = await fetch(`${routerUrl}/missing`, { signal: AbortSignal.timeout(3000) });
    expect(routeMissing.status).toBe(404);

    await new Promise<void>((resolve) => routerServer.close(() => resolve()));

    const errorHandler = (err: Error, req: any, res: any, next: any) =>
      res.status(418).send(err.message);
    const app = express()
      .use(toNodeHandler(toFetchHandler(middleware)) as NodeHttp1Handler)
      .get("/next", (req, res) => res.send("next route"))
      // The types reject an error handler, but untyped code that converts every middleware passes one.
      .use(toNodeHandler(toFetchHandler(errorHandler as any)) as NodeHttp1Handler);
    const appServer = createServer(app);
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    const appUrl = `http://localhost:${(appServer.address() as AddressInfo).port}`;

    const appNext = await fetch(`${appUrl}/next`);
    expect(appNext.headers.get("x-mw")).toBe("1");
    expect(await appNext.text()).toBe("next route");

    const appError = await fetch(`${appUrl}/error`);
    expect(appError.status).toBe(418);
    expect(await appError.text()).toBe("boom");

    await new Promise<void>((resolve) => appServer.close(() => resolve()));

    // Express 5 sends a rejected promise from a handler to its error handler.
    const asyncMiddleware = async (
      _req: NodeServerRequest,
      _res: NodeServerResponse,
      _next: (error?: Error) => void,
    ) => {
      throw new Error("async boom");
    };
    const asyncApp = express()
      .use(toNodeHandler(toFetchHandler(asyncMiddleware)) as NodeHttp1Handler)
      .use((err: Error, req: any, res: any, next: any) => res.status(418).send(err.message));
    const asyncServer = createServer(asyncApp);
    await new Promise<void>((resolve) => asyncServer.listen(0, resolve));
    const asyncRes = await fetch(
      `http://localhost:${(asyncServer.address() as AddressInfo).port}/`,
      { signal: AbortSignal.timeout(3000) },
    );
    expect(asyncRes.status).toBe(418);
    expect(await asyncRes.text()).toBe("async boom");

    await new Promise<void>((resolve) => asyncServer.close(() => resolve()));
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

  test("should read body when stream was pre-drained by middleware with rawBody", async () => {
    let rawBodyDone: () => void;
    const rawBodyPromise = new Promise<void>((resolve) => {
      rawBodyDone = resolve;
    });

    const handler = toNodeHandler(async (request) => {
      await rawBodyPromise;
      return new Response(await request.text());
    });

    const server = createServer(async (req: any, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        chunks.push(c);
      }
      req.rawBody = Buffer.concat(chunks);
      rawBodyDone();
      handler(req, res as any);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}`, {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("should parse json body when stream was pre-drained by middleware with rawBody", async () => {
    const handler = toNodeHandler(async (request) => {
      return Response.json(await request.json());
    });

    const server = createServer(async (req: any, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        chunks.push(c);
      }
      req.rawBody = Buffer.concat(chunks);
      handler(req, res as any);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}`, {
      method: "POST",
      body: JSON.stringify({ test: 123 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ test: 123 });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // "12345678" reads the same as text, JSON and a form's only key.
  const rawBodyReaders = {
    "text()": (req: Request) => req.text(),
    "json()": (req: Request) => req.json().then(String),
    "arrayBuffer()": (req: Request) => req.arrayBuffer().then((b) => new TextDecoder().decode(b)),
    "bytes()": (req: Request) => req.bytes().then((b) => new TextDecoder().decode(b)),
    "blob()": (req: Request) => req.blob().then((b) => b.text()),
    "formData()": (req: Request) => req.formData().then((f) => [...f.keys()].join()),
    body: (req: Request) => new Response(req.body).text(),
  } as const;

  for (const [name, read] of Object.entries(rawBodyReaders)) {
    test(`should read a pre-drained rawBody via ${name} within maxRequestBodySize`, async () => {
      const handler = toNodeHandler(
        async (request) => {
          try {
            return new Response(await read(request));
          } catch (error: any) {
            return new Response(error.code ?? error.message, { status: error.statusCode ?? 500 });
          }
        },
        { maxRequestBodySize: 8 },
      );

      const server = createServer(async (req: any, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(c);
        }
        req.rawBody = Buffer.concat(chunks);
        handler(req, res as any);
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const url = `http://localhost:${(server.address() as AddressInfo).port}`;
      const headers = { "content-type": "application/x-www-form-urlencoded" };

      const res = await fetch(url, { method: "POST", headers, body: "12345678" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("12345678");

      const tooLarge = await fetch(url, { method: "POST", headers, body: "123456789" });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).toBe("ERR_BODY_TOO_LARGE");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  }

  // `IncomingMessage` is `autoDestroy`, so a fully read body leaves `req`
  // destroyed while the response is still open. Touching `signal` only *after*
  // the read is the order that catches a disconnect check keying off
  // `req.destroyed` alone -- it would abort every healthy handler that reads its
  // body first, breaking the common `fetch(upstream, { signal: request.signal })`
  // proxy shape.
  test("should not abort when the signal is first read after the body", async () => {
    let aborted: boolean | undefined;
    let receivedBody: string | undefined;

    const server = serve({
      port: 0,
      async fetch(request) {
        receivedBody = await request.text();
        aborted = request.signal.aborted;
        return new Response(`Received: ${receivedBody}`);
      },
    });

    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "test body" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Received: test body");

    await server.close();

    expect(receivedBody).toBe("test body");
    expect(aborted).toBe(false);
  });

  test("should not abort when the signal is first read after a streamed body", async () => {
    let aborted: boolean | undefined;

    const server = serve({
      port: 0,
      async fetch(request) {
        await new Response(request.body).text();
        aborted = request.signal.aborted;
        return new Response("ok");
      },
    });

    await server.ready();

    const res = await fetch(server.url!, { method: "POST", body: "test body" });
    expect(await res.text()).toBe("ok");

    await server.close();

    expect(aborted).toBe(false);
  });

  // The HTTP/2 half of the two guards above. `Http2ServerRequest` reports
  // `complete === true` for an *aborted* body and never destroys itself, so the
  // HTTP/1 disconnect conditions are inert there and the predicate has to lean on
  // `req.aborted` instead -- which must stay false for a request that finished
  // normally, or `fetch(upstream, { signal: request.signal })` breaks for every
  // handler that reads its body before touching `signal`.
  describe.skipIf(skipHttp2)("http2", () => {
    async function serveAndPost(fetchHandler: (request: any) => Promise<Response>) {
      const tls = await getTLSCert();
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        silent: true,
        tls,
        node: { http2: true, allowHTTP1: false } as any,
        fetch: fetchHandler,
      });
      await server.ready();
      const client = http2.connect(server.url!, { ca: tls.ca, servername: "localhost" });
      client.on("error", () => {});
      try {
        const stream = client.request({ ":method": "POST", ":path": "/", "content-length": 9 });
        stream.end("test body");
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        await new Promise((resolve, reject) => {
          stream.once("end", resolve);
          stream.once("error", reject);
        });
        return Buffer.concat(chunks).toString();
      } finally {
        client.destroy();
        await server.close(true);
      }
    }

    test("should not abort when the signal is first read after the body", async () => {
      let aborted: boolean | undefined;
      let receivedBody: string | undefined;

      const body = await serveAndPost(async (request) => {
        receivedBody = await request.text();
        aborted = request.signal.aborted;
        return new Response(`Received: ${receivedBody}`);
      });

      expect(body).toBe("Received: test body");
      expect(receivedBody).toBe("test body");
      expect(aborted).toBe(false);
    });

    test("should not abort when the signal is first read after a streamed body", async () => {
      let aborted: boolean | undefined;
      let receivedBody: string | undefined;

      const body = await serveAndPost(async (request) => {
        receivedBody = await new Response(request.body).text();
        aborted = request.signal.aborted;
        return new Response("ok");
      });

      expect(body).toBe("ok");
      expect(receivedBody).toBe("test body");
      expect(aborted).toBe(false);
    });

    // Responding without reading closes the stream while the promised body is
    // still outstanding, which leaves `complete`/`readableEnded` true on an
    // untouched request -- neither can stand in for the disconnect check.
    test("should not abort when the body is never read", async () => {
      let aborted: boolean | undefined;

      const body = await serveAndPost(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        aborted = request.signal.aborted;
        return new Response("ok");
      });

      expect(body).toBe("ok");
      expect(aborted).toBe(false);
    });
  });

  test.skipIf(noBunCompat)("should fire abort signal when client disconnects", async () => {
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
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const server = serve({
          port,
          hostname: "127.0.0.1",
          fetch: () => new Response(""),
        });
        await expect(server.ready()).rejects.toMatchObject({ code: "EADDRINUSE" });
        // Claimed by `ready()`, so the last-resort report stays quiet.
        expect(consoleError).not.toHaveBeenCalled();
        await server.close();
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  // F18: nothing forces a caller to await `ready()`, and a failed listen leaves
  // no open handle -- so a bare `serve({ port })` used to exit 0 in silence with
  // a dead server, invisible to a supervisor watching the exit code.
  test("auto-serve port conflict is reported when nothing awaits ready()", async () => {
    const previousExitCode = process.exitCode;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withBlockedPort(async (port) => {
        const server = serve({
          port,
          hostname: "127.0.0.1",
          fetch: () => new Response(""),
        });
        await vi.waitFor(() =>
          expect(consoleError).toHaveBeenCalledWith(
            "[srvx] Failed to start server:",
            expect.objectContaining({ code: "EADDRINUSE" }),
          ),
        );
        expect(process.exitCode).toBe(1);
        await server.close();
      });
    } finally {
      consoleError.mockRestore();
      // Never leak the failure marker into vitest's own exit code.
      process.exitCode = previousExitCode;
    }
  });

  test("auto-serve port conflict log is muted by `silent`", async () => {
    const previousExitCode = process.exitCode;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withBlockedPort(async (port) => {
        const server = serve({
          port,
          hostname: "127.0.0.1",
          silent: true,
          fetch: () => new Response(""),
        });
        // `silent` mutes the log but not the exit code: the server is still dead.
        await vi.waitFor(() => expect(process.exitCode).toBe(1));
        expect(consoleError).not.toHaveBeenCalled();
        await server.close();
      });
    } finally {
      consoleError.mockRestore();
      process.exitCode = previousExitCode;
    }
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

// https://github.com/h3js/srvx/issues/332
describe("FastResponse keeps derived content-length once materialized", () => {
  const view = new DataView(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer, 1, 3);
  const cases: [string, () => BodyInit, string, string | null][] = [
    ["string", () => "héllo", "6", "text/plain;charset=UTF-8"],
    ["empty string", () => "", "0", "text/plain;charset=UTF-8"],
    ["ArrayBuffer", () => new ArrayBuffer(4), "4", null],
    ["Uint8Array", () => new Uint8Array(7), "7", null],
    ["DataView", () => view, "3", null],
    ["Blob", () => new Blob(["abc"], { type: "text/css" }), "3", "text/css"],
  ];

  test.skipIf(noBunCompat).each(cases)(
    "%s body is sent content-length framed after reading .body",
    async (_, body, length, type) => {
      const server = serve({
        port: 0,
        fetch() {
          const res = new FastResponse(body());
          void res.body;
          return res;
        },
      });
      await server.ready();
      try {
        const res = await fetch(server.url!);
        expect(res.headers.get("content-length")).toBe(length);
        expect(res.headers.get("content-type")).toBe(type);
        expect(res.headers.get("transfer-encoding")).toBeNull();
        expect((await res.arrayBuffer()).byteLength).toBe(Number(length));

        const headRes = await fetch(server.url!, { method: "HEAD" });
        expect(headRes.headers.get("content-length")).toBe(length);
      } finally {
        await server.close(true);
      }
    },
  );

  test.skipIf(noBunCompat)("user headers take precedence", () => {
    const res = new FastResponse("hello", {
      headers: { "Content-Type": "text/html", "Content-Length": "999" },
    });
    void res.body;
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("content-length")).toBe("999");
  });

  test.skipIf(noBunCompat)("keeps headers mutated before materializing", () => {
    const res = new FastResponse("hello");
    res.headers.set("x-custom", "1");
    void res.body;
    expect(res.headers.get("x-custom")).toBe("1");
  });

  test.skipIf(noBunCompat)("does not mutate a shared Headers init", () => {
    const shared = new Headers({ a: "1" });
    void new FastResponse("hello", { headers: shared }).body;
    expect([...shared]).toEqual([["a", "1"]]);
  });

  test.skipIf(noBunCompat)("streams get no content-length", () => {
    const res = new FastResponse(new ReadableStream());
    void res.body;
    expect(res.headers.get("content-length")).toBeNull();
  });

  test.skipIf(noBunCompat)(
    "a consumed body is sent without the derived content-length",
    async () => {
      const server = serve({
        port: 0,
        async fetch() {
          const res = new FastResponse("hello");
          const reader = res.body!.getReader();
          while (!(await reader.read()).done);
          reader.releaseLock();
          return res;
        },
      });
      await server.ready();
      try {
        const res = await fetch(server.url!, { signal: AbortSignal.timeout(2000) });
        expect(res.headers.get("content-length")).toBeNull();
        expect(await res.text()).toBe("");
      } finally {
        await server.close(true);
      }
    },
  );
});

describe("FastResponse headers match native Response after reading the body", () => {
  const NativeResponse = globalThis.Response;
  const bodies: [string, () => BodyInit][] = [
    ["string", () => "héllo"],
    ["empty string", () => ""],
    ["ArrayBuffer", () => new ArrayBuffer(4)],
    ["Uint8Array", () => new Uint8Array(7)],
    ["DataView", () => new DataView(new ArrayBuffer(6), 1, 3)],
    ["Blob", () => new Blob(["abc"], { type: "text/css" })],
    ["untyped Blob", () => new Blob(["abc"])],
    ["ReadableStream", () => new Blob(["abc"]).stream()],
  ];
  const reads: [string, (res: Response) => unknown][] = [
    ["text()", (res) => res.text()],
    ["arrayBuffer()", (res) => res.arrayBuffer()],
    ["clone()", (res) => res.clone()],
    [".body", (res) => res.body],
  ];

  describe.each(reads)("%s", (_, read) => {
    test.each(bodies)("%s body", async (_, body) => {
      const init = { headers: { "x-custom": "1" } };
      const native = new NativeResponse(body(), init);
      const fast = new FastResponse(body(), init);
      await read(native);
      await read(fast);
      expect([...fast.headers]).toEqual([...native.headers]);
    });
  });

  test("a response rebuilt from read headers is sent with its own length", async () => {
    const server = serve({
      port: 0,
      async fetch() {
        const res = new FastResponse("<html>abc</html>", {
          headers: { "content-type": "text/html" },
        });
        const html = await res.text();
        return new FastResponse(html + "<!-- overlay -->", { headers: res.headers });
      },
    });
    await server.ready();
    try {
      const res = await fetch(server.url!);
      expect(res.headers.get("content-length")).toBe("32");
      expect(await res.text()).toBe("<html>abc</html><!-- overlay -->");
    } finally {
      await server.close(true);
    }
  });
});

// https://github.com/h3js/srvx/issues/250
describe("FastResponse copies init Headers", () => {
  const headerPairs = (headers: string[]) => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < headers.length; i += 2) {
      pairs.push([headers[i], headers[i + 1]]);
    }
    return pairs;
  };

  test("mutating res.headers does not leak into a shared Headers init", () => {
    const shared = new Headers({ a: "1" });

    const res = new FastResponse("x", { headers: shared });
    res.headers.set("b", "2");

    expect(shared.has("b")).toBe(false);
    expect(res.headers.get("a")).toBe("1");
    expect(res.headers.get("b")).toBe("2");
  });

  test("a shared Headers template survives reuse across responses", () => {
    const preset = new Headers({ "x-preset": "1" });

    const first = new FastResponse("x", { headers: preset });
    first.headers.append("set-cookie", "session=abc");

    const second = new FastResponse("y", { headers: preset });

    expect(second.headers.getSetCookie()).toEqual([]);
    expect(first.headers.getSetCookie()).toEqual(["session=abc"]);
  });

  test("the copy preserves multiple set-cookie values", () => {
    const shared = new Headers();
    shared.append("set-cookie", "a=1");
    shared.append("set-cookie", "b=2");

    const res = new FastResponse("x", { headers: shared });

    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("mutations via res.headers reach the wire", () => {
    const res = new FastResponse("x", { headers: new Headers({ a: "1" }) });
    res.headers.set("b", "2");

    const { headers } = res._toNodeResponse();

    expect(headerPairs(headers)).toContainEqual(["a", "1"]);
    expect(headerPairs(headers)).toContainEqual(["b", "2"]);
  });

  test("an untouched Headers init still reaches the wire", () => {
    const { headers } = new FastResponse("x", {
      headers: new Headers({ a: "1" }),
    })._toNodeResponse();

    expect(headerPairs(headers)).toContainEqual(["a", "1"]);
  });
});

// https://github.com/h3js/srvx/issues/343
// A response passed as init exposes `status`/`statusText` as prototype getters,
// so they must not be read by spreading it.
describe("FastResponse keeps the status of a response used as init", () => {
  const forbidden = () => new FastResponse("denied", { status: 403, statusText: "Forbidden" });

  test("copy with mutated headers keeps its status once materialized", () => {
    const copy = new FastResponse("denied", forbidden());
    copy.headers.set("x-extra", "1");

    const clone = copy.clone();
    expect(clone.status).toBe(403);
    expect(clone.statusText).toBe("Forbidden");
    expect(clone.headers.get("x-extra")).toBe("1");
    expect(copy.status).toBe(403);
    expect(copy.statusText).toBe("Forbidden");
  });

  test("copy with mutated headers keeps its status on the wire", async () => {
    const copy = new FastResponse("denied", forbidden());
    copy.headers.set("x-extra", "1");
    void copy.body; // materialize

    const prepared = copy._toNodeResponse();
    expect(prepared.status).toBe(403);
    expect(prepared.statusText).toBe("Forbidden");
    expect(prepared.headers).toContain("x-extra");
  });

  test("a native response works as init too", () => {
    const copy = new FastResponse("denied", new Response(null, { status: 403 }));
    copy.headers.set("x-extra", "1");

    expect(copy.clone().status).toBe(403);
  });

  test("json() keeps the status of a response init", () => {
    const res = FastResponse.json({ error: "denied" }, forbidden());

    expect(res.status).toBe(403);
    expect(res.statusText).toBe("Forbidden");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.clone().status).toBe(403);
  });
});

// RFC 9110 §8.6: no Content-Length on 1xx/204, and on 304 only the length a 200
// would have had (never the length of an ignored body). Native `Response` rejects
// a body on a null-body status; `FastResponse` skips that check, so the body is
// ignored instead, as if it were `null`.
describe("FastResponse ignores the body of a null-body status", () => {
  async function rawGet(fetch: () => Response): Promise<{ head: string; rest: string }> {
    const server = serve({ port: 0, hostname: "127.0.0.1", fetch });
    await server.ready();
    try {
      const u = new URL(server.url!);
      const raw = await rawExchange(
        Number(u.port),
        u.hostname,
        `GET / HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\n\r\n`,
      );
      const [head, ...rest] = raw.toString("latin1").split("\r\n\r\n");
      return { head: head.toLowerCase(), rest: rest.join("\r\n\r\n") };
    } finally {
      await server.close(true);
    }
  }

  const bodies: [string, () => BodyInit][] = [
    ["string", () => "hello"],
    ["empty string", () => ""],
    ["Uint8Array", () => new TextEncoder().encode("hello")],
    ["Blob", () => new Blob(["hello"], { type: "text/css" })],
    ["URLSearchParams", () => new URLSearchParams("hello=1")],
  ];

  describe.each([204, 205, 304])("%s", (status) => {
    test.each(bodies)("%s body sends no derived headers and no body bytes", async (_, body) => {
      const { head, rest } = await rawGet(() => new FastResponse(body(), { status }));
      expect(head).toMatch(new RegExp(`^http/1.1 ${status} `));
      expect(head).not.toContain("content-length:");
      expect(head).not.toContain("content-type:");
      expect(rest).not.toContain("hello");
    });

    test("ReadableStream body is cancelled, not sent", async () => {
      let cancelled = false;
      let pulls = 0;
      const { head, rest } = await rawGet(
        () =>
          new FastResponse(
            new ReadableStream({
              pull(controller) {
                // Bounded so a regression fails below instead of pumping an
                // ignored body forever (Node's no-op `write()` never backpressures).
                if (++pulls > 64) return controller.close();
                controller.enqueue(new TextEncoder().encode("hello"));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          ),
      );
      expect(head).not.toContain("content-length:");
      expect(rest).not.toContain("hello");
      expect(cancelled).toBe(true);
    });

    test("Node Readable body is destroyed, not sent", async () => {
      let readable!: Readable;
      const { head, rest } = await rawGet(() => {
        // Never ends: an ignored body must be destroyed up front, not piped
        // into a response that can then never finish.
        readable = new Readable({ read() {} });
        readable.push("hello");
        return new FastResponse(readable as unknown as BodyInit, { status });
      });
      expect(head).not.toContain("content-length:");
      expect(rest).not.toContain("hello");
      expect(readable.destroyed).toBe(true);
    });

    test("materializing drops the body instead of throwing", async () => {
      const res = new FastResponse("hello", { status, headers: { "x-custom": "1" } });
      expect(res.body).toBeNull();
      expect(await res.text()).toBe("");
      expect(res.status).toBe(status);
      expect(res.headers.get("x-custom")).toBe("1");
      expect(res.headers.get("content-length")).toBeNull();
    });
  });

  test.each([101, 103])("%s gets no derived content-length", (status) => {
    const { headers, body } = new FastResponse("hello", { status })._toNodeResponse();
    expect(headers).not.toContain("content-length");
    expect(headers).not.toContain("content-type");
    expect(body).toBeUndefined();
  });

  test("a numeric string status is recognized", async () => {
    const { head, rest } = await rawGet(
      () => new FastResponse("hello", { status: "204" as unknown as number }),
    );
    expect(head).toMatch(/^http\/1.1 204 /);
    expect(head).not.toContain("content-length:");
    expect(rest).toBe("");
  });

  // Over HTTP/2 a body or content-length on 204/205 is a protocol error: the
  // stream was reset with `NGHTTP2_PROTOCOL_ERROR` instead of answering.
  describe.skipIf(skipHttp2)("http2", () => {
    async function h2Get(fetch: () => Response) {
      const tls = await getTLSCert();
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        silent: true,
        tls,
        node: { http2: true, allowHTTP1: false } as any,
        fetch,
      });
      await server.ready();
      const client = http2.connect(server.url!, { ca: tls.ca, servername: "localhost" });
      client.on("error", () => {});
      try {
        const stream = client.request({ ":method": "GET", ":path": "/" });
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        const [headers, error] = await Promise.all([
          new Promise<http2.IncomingHttpHeaders | undefined>((resolve) => {
            stream.once("response", resolve);
            stream.once("close", () => resolve(undefined));
          }),
          new Promise<Error | undefined>((resolve) => {
            stream.once("end", () => resolve(undefined));
            stream.once("error", resolve);
          }),
        ]);
        return { headers, error, body: Buffer.concat(chunks).toString() };
      } finally {
        client.destroy();
        await server.close(true);
      }
    }

    test.each([204, 205, 304])("%s with a string body", async (status) => {
      const { headers, error, body } = await h2Get(() => new FastResponse("hello", { status }));
      expect(error).toBeUndefined();
      expect(headers?.[":status"]).toBe(status);
      expect(headers?.["content-length"]).toBeUndefined();
      expect(headers?.["content-type"]).toBeUndefined();
      expect(body).toBe("");
    });
  });

  test("an explicit content-length on a 304 is kept", async () => {
    const { head, rest } = await rawGet(
      () =>
        new FastResponse("hello", {
          status: 304,
          headers: { "content-length": "42", etag: '"abc"' },
        }),
    );
    expect(head).toMatch(/^http\/1.1 304 /);
    expect(head).toContain("content-length: 42");
    expect(head).toContain('etag: "abc"');
    expect(head).not.toContain("content-type:");
    expect(rest).toBe("");
  });

  test("a 200 still gets the derived headers", async () => {
    const { head, rest } = await rawGet(() => new FastResponse("hello"));
    expect(head).toContain("content-length: 5");
    expect(rest).toBe("hello");
  });
});

// Documented in docs/1.guide/08.node.md#adding-headers-to-a-response: a middleware
// decorating a response must be able to mutate `res.headers` without paying for
// materialization. Frameworks build on this instead of `new FastResponse(res.body, ...)`,
// which is ~2x slower because it replaces the raw body with a ReadableStream.
describe("FastResponse header mutation preserves the raw body", () => {
  test("mutating headers keeps a string body raw", () => {
    const res = new FastResponse("hello world", { headers: { "x-a": "1" } });
    res.headers.append("set-cookie", "session=abc");

    const prepared = res._toNodeResponse();

    expect(prepared.body).toBe("hello world");
    expect(prepared.headers).toContain("session=abc");
    // Implicit content-type/length are still derived from the raw body.
    expect(prepared.headers).toContain("text/plain; charset=UTF-8");
    expect(prepared.headers).toContain("11");
  });

  test("mutating headers keeps a Uint8Array body raw", () => {
    const body = new TextEncoder().encode("hello world");
    const res = new FastResponse(body);
    res.headers.set("x-a", "1");

    expect(res._toNodeResponse().body).toBe(body);
  });

  test("reading .body is what forfeits the fast path", () => {
    const res = new FastResponse("hello world");
    void res.body;

    expect(res._toNodeResponse().body).toBeInstanceOf(ReadableStream);
  });

  test("headers stay mutable after materialization", () => {
    const res = new FastResponse("hello world");
    void res.body; // materialize

    expect(() => res.headers.append("set-cookie", "session=abc")).not.toThrow();
    expect(res._toNodeResponse().headers).toContain("session=abc");
  });

  test("a plain Response is mutable too, so middleware need not branch", () => {
    // Only fetch()/Response.error()/Response.redirect() results are immutable.
    const res = new Response("hello world");

    expect(() => {
      res.headers.set("cache-control", "no-store");
      res.headers.append("set-cookie", "session=abc");
    }).not.toThrow();
    expect(res.headers.getSetCookie()).toEqual(["session=abc"]);
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
  test.skipIf(isDeno || noBunCompat)(
    "streaming the body directly marks it used and rejects later reads",
    async () => {
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
    },
  );

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
  test.skipIf(isDeno || noBunCompat)(
    "cancelling req.body marks the body used and rejects later reads",
    async () => {
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
    },
  );

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

// arrayBuffer()/bytes()/blob() read straight off the Node stream (like
// text()/json()) instead of through a native Request over `Readable.toWeb`. The
// results must still be indistinguishable from what native fetch returns.
describe("node direct body reads (arrayBuffer / bytes / blob)", () => {
  async function withServer(
    fetchHandler: (req: Request) => Response | Promise<Response>,
    run: (url: string) => Promise<void>,
    options: { maxRequestBodySize?: number } = {},
  ) {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      ...options,
      fetch: fetchHandler as any,
    });
    await server.ready();
    try {
      await run(server.url!);
    } finally {
      await server.close(true);
    }
  }

  // 5 B and 3 KiB land in Node's shared `Buffer` pool (`Buffer.concat` /
  // `allocUnsafe` below 4 KiB); 256 KiB arrives over many socket reads.
  const sizes = [0, 5, 3 * 1024, 256 * 1024];
  const payload = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251);
  const digest = (bytes: Uint8Array) => {
    let h = bytes.length;
    for (const b of bytes) h = (h * 33 + b) >>> 0;
    return h;
  };

  for (const size of sizes) {
    test(`bytes() / arrayBuffer() return standalone, exact-length copies (${size} B)`, async () => {
      const body = payload(size);
      await withServer(
        async (req) => {
          const read =
            new URL(req.url).searchParams.get("m") === "bytes"
              ? await req.bytes()
              : await req.arrayBuffer();
          // Inspect bytes() as returned (wrapping it would copy).
          const result = read instanceof Uint8Array ? read : new Uint8Array(read);
          return Response.json({
            ctor: read.constructor.name,
            byteLength: result.byteLength,
            byteOffset: result.byteOffset,
            bufferByteLength: result.buffer.byteLength,
            digest: digest(result),
          });
        },
        async (url) => {
          for (const m of ["bytes", "arrayBuffer"]) {
            const res = await fetch(`${url}?m=${m}`, { method: "POST", body });
            expect(await res.json()).toEqual({
              // A plain Uint8Array (not a Buffer) / a plain ArrayBuffer.
              ctor: m === "bytes" ? "Uint8Array" : "ArrayBuffer",
              byteLength: size,
              byteOffset: 0,
              // Not a view into Node's buffer pool or the socket read buffer.
              bufferByteLength: size,
              digest: digest(body),
            });
          }
        },
      );
    });
  }

  // The only assertions here that the old route (a native Request over
  // `Readable.toWeb`) cannot satisfy: it wraps the Node stream, and leaves `body`
  // as the drained (non-null) stream.
  for (const method of ["arrayBuffer", "bytes", "blob"] as const) {
    test(`${method}() reads the Node stream directly, without Readable.toWeb`, async () => {
      const toWeb = vi.spyOn(Readable, "toWeb");
      try {
        await withServer(
          async (req) => {
            await req[method]();
            return Response.json({
              toWebCalls: toWeb.mock.calls.length,
              bodyNull: req.body === null,
            });
          },
          async (url) => {
            const res = await fetch(url, { method: "POST", body: "hello" });
            expect(await res.json()).toEqual({ toWebCalls: 0, bodyNull: true });
          },
        );
      } finally {
        toWeb.mockRestore();
      }
    });
  }

  test("bytes() results do not share memory across requests", async () => {
    const seen: Uint8Array[] = [];
    await withServer(
      async (req) => {
        const bytes = await req.bytes();
        seen.push(bytes);
        bytes.fill(0); // must not clobber anything else
        return new Response(String(seen.length));
      },
      async (url) => {
        for (const body of ["first", "second"]) {
          await (await fetch(url, { method: "POST", body })).text();
        }
      },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0].buffer).not.toBe(seen[1].buffer);
  });

  test("bytes() copies a pre-drained rawBody instead of aliasing it", async () => {
    let rawBodyAfter: string | undefined;
    const handler = toNodeHandler(async (request) => {
      const bytes = await request.bytes();
      bytes.fill(0x21); // "!"
      return new Response(String(bytes.buffer.byteLength));
    });
    const server = createServer(async (req: any, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      req.rawBody = Buffer.concat(chunks);
      res.on("finish", () => (rawBodyAfter = req.rawBody.toString()));
      handler(req, res as any);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const url = `http://localhost:${(server.address() as AddressInfo).port}`;
      const res = await fetch(url, { method: "POST", body: "hello" });
      expect(await res.text()).toBe("5");
      expect(rawBodyAfter).toBe("hello");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Whatever native `Request.blob()` derives from `Content-Type` (WHATWG
  // "extract a MIME type" + `Blob`'s lowercasing). Bun's own Request ignores the
  // header for a stream body and always yields "", so the native reference
  // itself is not meaningful there.
  const contentTypes = [
    undefined,
    "application/octet-stream",
    "Text/Plain; charset=UTF-8",
    'TEXT/HTML;Charset="utf-8"',
    "application/json; charset=utf-8; foo=bar",
    "multipart/form-data; boundary=----abc",
    "text/plain;",
    "*/*",
    "invalid",
    "text/ plain",
  ];
  test.skipIf(isBun)("blob() type matches native Request.blob()", async () => {
    await withServer(
      async (req) => {
        const blob = await req.blob();
        return Response.json({ type: blob.type, text: await blob.text() });
      },
      async (url) => {
        // Each type twice in a row: the second read is served from the
        // last-type memo.
        for (const contentType of contentTypes.flatMap((type) => [type, type])) {
          const headers: Record<string, string> =
            contentType === undefined ? {} : { "content-type": contentType };
          const native = await new Request("http://localhost/", {
            method: "POST",
            headers,
            body: new Blob(["x"]).stream(),
            duplex: "half",
          } as RequestInit).blob();
          const res = await fetch(url, { method: "POST", headers, body: new Blob(["hello"]) });
          expect(await res.json(), String(contentType)).toEqual({
            type: native.type,
            text: "hello",
          });
        }
      },
    );
    // Spot-check the reference itself so a runtime change can't hide here.
    const ref = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "Text/Plain; charset=UTF-8" },
      body: new Blob(["x"]).stream(),
      duplex: "half",
    } as RequestInit).blob();
    expect(ref.type).toBe("text/plain;charset=utf-8");
  });

  test.skipIf(isBun)("blob() type honors a content-type set through req.headers", async () => {
    await withServer(
      async (req) => {
        req.headers.set("content-type", "Application/JSON");
        return new Response((await req.blob()).type);
      },
      async (url) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });
        expect(await res.text()).toBe("application/json");
      },
    );
  });

  for (const first of ["arrayBuffer", "bytes", "blob"] as const) {
    test(`${first}() marks the body used and every later read rejects`, async () => {
      await withServer(
        async (req) => {
          const before = req.bodyUsed;
          await req[first]();
          const outcomes: Record<string, string> = {
            before: String(before),
            after: String(req.bodyUsed),
          };
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
        async (url) => {
          const res = await fetch(url, { method: "POST", body: "hello" });
          expect(await res.json()).toEqual({
            before: "false",
            after: "true",
            arrayBuffer: "TypeError: unusable",
            bytes: "TypeError: unusable",
            blob: "TypeError: unusable",
            formData: "TypeError: unusable",
            text: "TypeError: unusable",
            json: "TypeError: unusable",
          });
        },
      );
    });
  }

  // Bodies that something else already touched keep going through the native
  // Request, which must still read them once.
  const preludes = {
    "after req.body was accessed": (req: Request) => void req.body,
    "after _request was materialized": (req: Request) => void (req as any)._request,
    "after a clone was read": (req: Request) => req.clone().text(),
  } as const;
  for (const [name, prelude] of Object.entries(preludes)) {
    test(`bytes() still reads the body ${name}`, async () => {
      await withServer(
        async (req) => {
          await prelude(req);
          const bytes = await req.bytes();
          return Response.json({
            text: new TextDecoder().decode(bytes),
            bodyUsed: req.bodyUsed,
            second: await req.bytes().then(
              () => "resolved",
              (error) => (error instanceof TypeError ? "TypeError" : `other: ${error}`),
            ),
          });
        },
        async (url) => {
          const res = await fetch(url, { method: "POST", body: "hello" });
          expect(await res.json()).toEqual({ text: "hello", bodyUsed: true, second: "TypeError" });
        },
      );
    });
  }

  test("GET with a body on the wire reads as an empty, repeatable body", async () => {
    await withServer(
      async (req) => {
        const a = await req.arrayBuffer();
        const b = await req.bytes();
        const blob = await req.blob();
        return new FastResponse(
          JSON.stringify({
            arrayBuffer: a.byteLength,
            bytes: b.byteLength,
            blob: blob.size,
            bodyUsed: req.bodyUsed,
          }),
        );
      },
      async (url) => {
        const u = new URL(url);
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
        expect(JSON.parse(responses[0].body.toString())).toEqual({
          arrayBuffer: 0,
          bytes: 0,
          blob: 0,
          bodyUsed: false,
        });
      },
    );
  });

  for (const method of ["arrayBuffer", "bytes", "blob"] as const) {
    test(`${method}() enforces maxRequestBodySize on a chunked body`, async () => {
      await withServer(
        async (req) => {
          try {
            const result: any = await req[method]();
            return new Response(String(result.byteLength ?? result.size));
          } catch (error: any) {
            return new Response(error.code, { status: error.statusCode ?? 500 });
          }
        },
        async (url) => {
          // No content-length: only the streaming count can catch it.
          const chunked = (size: number) =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (let i = 0; i < size; i += 1024) controller.enqueue(new Uint8Array(1024));
                controller.close();
              },
            });
          const ok = await fetch(url, {
            method: "POST",
            body: chunked(8 * 1024),
            duplex: "half",
          } as RequestInit);
          expect(await ok.text()).toBe(String(8 * 1024));
          const tooLarge = await fetch(url, {
            method: "POST",
            body: chunked(64 * 1024),
            duplex: "half",
          } as RequestInit);
          expect(tooLarge.status).toBe(413);
          expect(await tooLarge.text()).toBe("ERR_BODY_TOO_LARGE");
        },
        { maxRequestBodySize: 8 * 1024 },
      );
    });
  }

  test.skipIf(skipHttp2)("bytes() reads an HTTP/2 body as a standalone copy", async () => {
    const tls = await getTLSCert();
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
      tls,
      node: { http2: true, allowHTTP1: false } as any,
      async fetch(req) {
        const bytes = await req.bytes();
        return Response.json({
          text: new TextDecoder().decode(bytes),
          bufferByteLength: bytes.buffer.byteLength,
        });
      },
    });
    await server.ready();
    const client = http2.connect(server.url!, { ca: tls.ca, servername: "localhost" });
    client.on("error", () => {});
    try {
      const stream = client.request({ ":method": "POST", ":path": "/", "content-length": 9 });
      stream.end("test body");
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("error", reject);
      });
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
        text: "test body",
        bufferByteLength: 9,
      });
    } finally {
      client.destroy();
      await server.close(true);
    }
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

  // Same guarantee for the Node `Readable` fast path, which goes through
  // pipeBody instead of streamBody. Node's write() is a no-op for HEAD, so
  // without the guard the stream is pumped with zero backpressure.
  test("HEAD discards a Node Readable body instead of pumping it", async () => {
    let reads = 0;
    let readable!: Readable;
    const server = serve({
      port: 0,
      fetch() {
        readable = new Readable({
          read() {
            reads++;
            // Bounded so a regression fails the assertion below instead of
            // OOMing the worker (the real-world body would be unbounded).
            this.push(reads > 64 ? null : Buffer.alloc(1024, "x"));
          },
        });
        return new FastResponse(readable as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    // Let the destroy settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(readable.destroyed).toBe(true);
    // The stream was destroyed up front rather than pumped.
    expect(reads).toBeLessThanOrEqual(1);
    await server.close(true);
  });

  // The HEAD guard still commits to the handler's status/headers, and does not
  // leak into non-HEAD requests on the same server.
  test("HEAD keeps the handler's headers for a Node Readable body", async () => {
    const server = serve({
      port: 0,
      fetch() {
        return new FastResponse(Readable.from(["hello", "world"]) as unknown as BodyInit, {
          status: 206,
          headers: { "content-length": "10", "x-custom": "1" },
        });
      },
    });
    await server.ready();

    const headRes = await fetch(server.url!, { method: "HEAD" });
    expect(headRes.status).toBe(206);
    expect(headRes.headers.get("content-length")).toBe("10");
    expect(headRes.headers.get("x-custom")).toBe("1");
    expect((await headRes.arrayBuffer()).byteLength).toBe(0);

    // A GET on the same server still streams the body.
    const getRes = await fetch(server.url!);
    expect(getRes.status).toBe(206);
    expect(await getRes.text()).toBe("helloworld");
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
  test.skipIf(noBunCompat)(
    "empty-string body keeps default content-type and content-length",
    () => {
      const { headers } = new FastResponse("")._toNodeResponse();
      const pairs = headerPairs(headers);
      expect(pairs).toContainEqual(["content-type", "text/plain; charset=UTF-8"]);
      expect(pairs).toContainEqual(["content-length", "0"]);

      // Sanity: a native Response agrees on the content-type.
      expect(new Response("").headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    },
  );

  // text()/json() on a locked/disturbed body stream must reject, not throw
  // synchronously.
  test.skipIf(noBunCompat)(
    "text() on a locked body stream rejects instead of throwing",
    async () => {
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
    },
  );

  // A headers reference taken before `_request` materialization must stay live:
  // `req.headers` keeps its identity and mutations through the old reference
  // remain visible (https://github.com/h3js/srvx/issues/245).
  test("headers reference stays live across _request materialization", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const h = req.headers;
        // Force materialization of the underlying native Request.
        void req._request;
        h.set("x-added-after", "1");
        return Response.json({
          sameIdentity: req.headers === h,
          viaGetter: req.headers.get("x-added-after"),
          viaRef: h.get("x-added-after"),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(await res.json()).toEqual({
      sameIdentity: true,
      viaGetter: "1",
      viaRef: "1",
    });
    await server.close(true);
  });

  // The dual of the identity test — the case that sank the #243 approach:
  // after materialization there is a single header store, so mutations through
  // `req.headers` must be visible to the native views (`_request.headers`,
  // `clone()`, and `formData()`'s content-type sniff), and vice versa.
  test("headers mutations after _request materialization reach both views", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const native = req._request!; // materialize first
        req.headers.set("x-via-wrapper", "1");
        native.headers.set("x-via-native", "1");
        return Response.json({
          nativeSeesWrapperSet: native.headers.get("x-via-wrapper"),
          cloneSeesWrapperSet: req.clone().headers.get("x-via-wrapper"),
          wrapperSeesNativeSet: req.headers.get("x-via-native"),
          preMaterializationHeader: native.headers.get("x-early"),
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, { headers: { "x-early": "yes" } });
    expect(await res.json()).toEqual({
      nativeSeesWrapperSet: "1",
      cloneSeesWrapperSet: "1",
      wrapperSeesNativeSet: "1",
      preMaterializationHeader: "yes",
    });
    await server.close(true);
  });

  // formData() sniffs content-type off the native request; a content-type set
  // via `req.headers` before the native Request exists must be honored.
  test("formData() sees content-type set through req.headers", async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        // Overwrite the incoming content-type before materialization.
        req.headers.set("content-type", "application/x-www-form-urlencoded");
        const form = await req.formData();
        return Response.json({ value: form.get("a") });
      },
    });
    await server.ready();

    const res = await fetch(server.url!, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a=1",
    });
    expect(await res.json()).toEqual({ value: "1" });
    await server.close(true);
  });

  // A synchronous send failure (e.g. an invalid header value hitting writeHead)
  // must be logged for diagnostics (unless silenced) and returned as a bare 500
  // without leaking details to the client.
  test.skipIf(isDeno)("send error is logged and returns a bare 500", async () => {
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

  test.skipIf(isDeno)("send error is not logged when the server is silent", async () => {
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
  test.skipIf(noBridge)(
    "synthetic IncomingMessage exposes httpVersion and rawHeaders",
    async () => {
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
    },
  );
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

// CI also runs this file under Bun and Deno, whose URL parsers differ from
// Node's; the trust-proxy plugin and the Node adapter both rely on this.
describe("isValidHost agrees with the runtime's URL parser", () => {
  test.each(HOST_PARSER_AGREEMENT_CASES)("%s", (host) => {
    expect(isValidHost(host)).toBe(URL.canParse(`http://${host}`));
    expect(isValidHost(host)).toBe(URL.canParse(`http://${host}`));
  });
});
