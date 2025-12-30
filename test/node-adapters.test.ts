import type {
  NodeHttp1Handler,
  NodeServerRequest,
  NodeServerResponse,
} from "../src/types.ts";
import {
  fetchNodeHandler,
  serve,
  toNodeHandler,
  toFetchHandler,
} from "../src/adapters/node.ts";

import express from "express";
import fastify from "fastify";

// Vitest is currently broken in Bun -_-
const { describe, expect, test } = globalThis.Bun
  ? ((await import("bun:test")) as unknown as typeof import("vitest"))
  : await import("vitest");

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

const fixtures: { name: string; skip?: boolean; handler: NodeHttp1Handler }[] =
  [
    {
      name: "node",
      handler: async (req, res) => {
        const body: any = await new Promise((resolve) => {
          const chunks: Uint8Array[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
          );
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

          expect(res.headers.get("Content-Type")).toBe(
            "application/json; charset=utf-8",
          );
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
    expect(webHandler.name).toBe(
      "simpleNodeHandler (converted to Web handler)",
    );
    const res = await webHandler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("toNodeHandler", async () => {
    const nodeHandler = toNodeHandler(simpleWebHandler);
    expect(nodeHandler.__fetchHandler).toBe(simpleWebHandler);
    expect(nodeHandler.name).toBe(
      "simpleWebHandler (converted to Node handler)",
    );

    const res = await fetchNodeHandler(
      nodeHandler,
      new Request("http://localhost/"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("toFetchHandler(toNodeHandler())", async () => {
    expect(toFetchHandler(toNodeHandler(simpleWebHandler))).toBe(
      simpleWebHandler,
    );
  });

  test("toNodeHandler(toFetchHandler())", async () => {
    expect(toNodeHandler(toFetchHandler(simpleNodeHandler))).toBe(
      simpleNodeHandler,
    );
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
        setTimeout(
          () => reject(new Error("Abort signal not fired within 1s")),
          1000,
        ),
      ),
    ]);

    await server.close(true); // Force close all connections
  });
});
