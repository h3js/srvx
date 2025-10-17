import { describe, expect, it } from "vitest";
import express from "express";
import type { NodeHttpHandler } from "../src/types.ts";
import { fetchNodeHandler, serve } from "../src/adapters/node.ts";

const fetchCallers = [
  {
    name: "direct fetch",
    // skip: true,
    fetchNodeHandler,
  },
  {
    name: "through srvx/node",
    skip: true,
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

describe("fetchNodeHandler", () => {
  // Fixture: simple Node.js HTTP handler
  const nodeHandler: NodeHttpHandler = async (req, res) => {
    // Read body
    const body: any = await new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () =>
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
      );
    });

    setImmediate(() => {
      res.writeHead(418, "I'm a teapot", {
        "Content-Type": "application/json; charset=utf-8",
      });
      const resBody = JSON.stringify({
        header: req.headers["x-test"] === "1",
        body: body?.test === true,
      });
      res.end(new TextEncoder().encode(resBody));
    });
  };

  // Fixture: simple Express handler
  const expressHandler = express()
    .use(express.json())
    .use("/", (req, res) => {
      res.json({
        header: req.headers["x-test"] === "1",
        body: req.body?.test === true,
      });
    });

  for (const caller of fetchCallers) {
    if (caller.skip) continue;
    describe(caller.name, () => {
      it("plain node handler", async () => {
        const res = await caller.fetchNodeHandler(
          nodeHandler,
          new Request("http://localhost/", {
            method: "POST",
            headers: { "x-test": "1", "Content-Type": "application/json" },
            body: JSON.stringify({ test: true }),
          }),
        );

        expect(res.status).toBe(418);
        expect(res.statusText).toBe("I'm a teapot");
        expect(res.headers.get("Content-Type")).toBe(
          "application/json; charset=utf-8",
        );
        expect(await res.json()).toMatchObject({ header: true, body: true });
      });

      it("express handler", { timeout: 500 }, async () => {
        const res = await caller.fetchNodeHandler(
          expressHandler as any,
          new Request("http://localhost/", {
            method: "POST",
            headers: { "x-test": "1", "Content-Type": "application/json" },
            body: JSON.stringify({ test: true }),
          }),
        );
        expect(res.status).toBe(200);
        expect(res.statusText).toBe("OK");
        expect(res.headers.get("Content-Type")).toBe(
          "application/json; charset=utf-8",
        );
        // TODO: body
        expect(await res.json()).toMatchObject({ header: true });
      });
    });
  }
});
