import { describe, expect, test } from "vitest";
import type { NodeHttpHandler } from "../src/types.ts";
import { fetchNodeHandler, serve } from "../src/adapters/node.ts";

import express from "express";
import fastify from "fastify";

const fetchCallers = [
  {
    name: "direct fetch",
    fetchNodeHandler,
  },
  {
    name: "through srvx/node",
    async fetchNodeHandler(handler: NodeHttpHandler, req: Request) {
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

const fixtures: { name: string; skip?: boolean; handler: NodeHttpHandler }[] = [
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
      }) as NodeHttpHandler,
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
      return app.routing as NodeHttpHandler;
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
