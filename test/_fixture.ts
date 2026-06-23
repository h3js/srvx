import { inspect } from "node:util";
import type { ServerOptions } from "../src/types.ts";
// srvx's node-adapter `FastResponse`. Returned by handlers/middleware that
// resolve srvx's `node` export condition; the bun/deno adapters must normalize
// it to a native Response (regression for h3js/srvx NodeResponse asymmetry).
import { NodeResponse } from "../src/adapters/_node/response.ts";

// Small real-time delay used to create timing windows in streaming/cancel
// tests. Kept short to minimize suite overhead while staying large enough to
// reliably interleave operations across the event loop.
const TEST_DELAY = 20;

// prettier-ignore
const runtime = (globalThis as any).Deno ? "deno" : (globalThis.Bun ? "bun" : "node");
const { serve } = (await import(
  `../src/adapters/${runtime}.ts`
)) as typeof import("../src/types.ts");

export const fixture: (
  opts?: Partial<ServerOptions>,
  _Response?: typeof globalThis.Response,
) => ServerOptions = (opts, _Response = globalThis.Response) => {
  const aborts: Array<{
    request: string; // example: GET /test
    reason: string;
  }> = [];

  return {
    ...opts,
    hostname: "localhost",
    middleware: [
      (req, next) => {
        // A middleware returning a node-adapter NodeResponse must also be
        // normalized to a native Response by the bun/deno adapters.
        if (req.headers.has("X-node-response-mw")) {
          return new NodeResponse("node-response from middleware");
        }
        if (req.headers.has("X-plugin-req")) {
          return new _Response("response from req plugin");
        }
        return next();
      },
    ],
    plugins: [
      (server) => {
        server.options.middleware ??= [];
        server.options.middleware.unshift(async (req, next) => {
          if (!req.headers.has("X-plugin-res")) {
            return next();
          }
          const res = await next();
          res.headers.set("x-plugin-header", "1");
          return res;
        });
      },
    ],

    async error(err: any) {
      if (err.toString() !== "Error: test error") {
        console.error(err);
      }
      return new _Response(`error: ${(err as Error).message}`, { status: 500 });
    },

    async fetch(req) {
      const url = new URL(req.url);

      req.signal.addEventListener("abort", () => {
        aborts.push({
          request: `${req.method} ${url.pathname}`,
          reason: req.signal.reason?.toString(),
        });
      });

      switch (url.pathname) {
        case "/": {
          return new _Response("ok");
        }
        case "/headers": {
          // Trigger Node.js writeHead slowpath to reproduce https://github.com/h3js/srvx/pull/40
          req.runtime?.node?.res?.setHeader("x-set-with-node", "");
          const resHeaders = new Headers();
          for (const [key, value] of req.headers) {
            resHeaders.append(`x-req-${key}`, value);
          }
          return Response.json(
            {
              ...Object.fromEntries(req.headers.entries()),
              unsetHeader: req.headers.get("" + Math.random()), // #44
            },
            {
              headers: resHeaders,
            },
          );
        }
        case "/headers/response/mutation": {
          const headers: Record<string, string> = {
            "x-test-header-1": "1",
          };
          const res = new _Response("", {
            headers: headers,
          });

          res.headers.set("x-test-header-2", "2");
          headers["x-ignored-mutation"] = "true";

          return res;
        }
        case "/body/binary": {
          return new _Response(req.body);
        }
        case "/body/text": {
          return new _Response(await req.text());
        }
        case "/ip": {
          return new _Response(`ip: ${req.ip}`);
        }
        case "/tls": {
          return Response.json({
            hasTls: !!req.tls,
            subjectCN: req.tls?.peerCertificate?.subject?.CN ?? null,
            issuerCN: req.tls?.peerCertificate?.issuer?.CN ?? null,
            authorized: req.tls?.authorized ?? null,
            protocol: req.tls?.protocol ?? null,
          });
        }
        case "/req-instanceof": {
          class MyRequst extends Request {}
          return Response.json({
            instanceofRequest: req instanceof Request ? "yes" : "no",
            instanceofExtended: req instanceof MyRequst ? "yes" : "no",
          });
        }
        case "/extended-req-instanceof": {
          class MyRequst extends Request {}
          const myReq = new MyRequst("http://example.com");
          return Response.json({
            instanceofRequest: myReq instanceof Request ? "yes" : "no",
            instanceofExtended: myReq instanceof MyRequst ? "yes" : "no",
          });
        }
        case "/req-headers-instanceof": {
          return new _Response(req.headers instanceof Headers ? "yes" : "no");
        }
        case "/req-clone": {
          const clone = req.clone();
          return Response.json({
            method: clone.method,
            pathname: new URL(clone.url).pathname,
            headers: Object.fromEntries(clone.headers),
          });
        }
        case "/req-new-req": {
          const clone = new Request(req._request || req);
          return Response.json({
            method: clone.method,
            pathname: new URL(clone.url).pathname,
            headers: Object.fromEntries(clone.headers),
          });
        }
        case "/error": {
          throw new Error("test error");
        }
        case "/response/ArrayBuffer": {
          const data = new TextEncoder().encode("hello!");
          return new _Response(data.buffer);
        }
        case "/response/Uint8Array": {
          const data = new TextEncoder().encode("hello!");
          return new _Response(data);
        }
        case "/response/ReadableStream": {
          return new _Response(
            new ReadableStream({
              start(controller) {
                const count = +url.searchParams.get("count")! || 3;
                for (let i = 0; i < count; i++) {
                  controller.enqueue(new TextEncoder().encode(`chunk${i}\n`));
                }
                controller.close();
              },
            }),
            {
              headers: {
                "content-type": "text/plain",
              },
            },
          );
        }
        case "/response/NodeReadable": {
          const { Readable } = process.getBuiltinModule("node:stream");
          // Yield Uint8Array chunks (the portable form of a Node Readable body):
          // Deno >=2.9 native Response rejects string chunks from an async
          // iterable, while node/bun exercise the same Readable->body path.
          const encoder = new TextEncoder();
          return new _Response(
            new Readable({
              read() {
                for (let i = 0; i < 3; i++) {
                  this.push(encoder.encode(`chunk${i}\n`));
                }
                this.push(null /* end stream */);
              },
            }) as any,
          );
        }
        case "/response/NodeResponse": {
          // A node-adapter NodeResponse must be normalized to a native Response
          // by the bun/deno adapters before reaching Bun.serve/Deno.serve.
          return new NodeResponse("node-response-ok", {
            headers: { "x-node-response": "1" },
          });
        }
        case "/response/NodeResponse/stream": {
          // Same, but with a streaming body to verify the unwrapped native
          // Response still streams correctly under bun/deno.
          return new NodeResponse(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 3; i++) {
                  controller.enqueue(new TextEncoder().encode(`chunk${i}\n`));
                }
                controller.close();
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        }
        case "/clone-response": {
          const res = new _Response("", {});
          if (req.headers.get("x-clone-with-headers") === "true") {
            res.headers.set("x-clone-with-headers", "true");
          }
          return res.clone();
        }
        case "/clone-node-stream": {
          // Test case for h3js/srvx issue: clone() should preserve Node.js pipe-style bodies
          // Create a response with a pipe-style body (like Node.js streams)
          const pipeBody = {
            pipe(writable: { write: (chunk: string) => void; end: () => void }) {
              writable.write("streamed-content");
              writable.end();
            },
          };
          const res = new _Response(pipeBody as any, {
            headers: { "content-type": "text/plain" },
          });
          // Clone the response (this should not break the original response's body)
          res.clone();
          return res;
        }
        case "/abort": {
          return new _Response(
            new ReadableStream({
              async start(controller) {
                while (!req.signal.aborted) {
                  controller.enqueue(new TextEncoder().encode(new Date().toISOString() + "\n"));
                  await new Promise((resolve) => setTimeout(resolve, TEST_DELAY));
                }
                controller.close();
              },
            }),
            {
              headers: {
                "content-type": "text/plain",
              },
            },
          );
        }
        case "/body-cancel": {
          const reader = req.body!.getReader();
          await reader.read();
          await reader.cancel();
          const abortedAfterCancel = false; // req.signal.aborted;
          await new Promise((resolve) => setTimeout(resolve, TEST_DELAY));
          const abortedAfterTimeout = req.signal.aborted;
          return _Response.json({
            abortedAfterCancel,
            abortedAfterTimeout,
          });
        }
        case "/response/stream-error": {
          const encoder = new TextEncoder();
          return new _Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode("chunk1\n"));
                await new Promise((resolve) => setTimeout(resolve, TEST_DELAY));
                controller.enqueue(encoder.encode("chunk2\n"));
                await new Promise((resolve) => setTimeout(resolve, TEST_DELAY));
                throw new Error("stream error!");
              },
            }),
            {
              headers: {
                "content-type": "text/plain",
              },
            },
          );
        }
        case "/abort-log": {
          return _Response.json(aborts);
        }
        case "/node-inspect": {
          return _Response.json({
            headers: inspect(req.headers),
          });
        }
        case "/bar/baz": {
          return Response.json({
            pathname: url.pathname,
            url: req.url,
          });
        }
      }
      return new _Response("404", { status: 404 });
    },
  };
};

if (import.meta.main) {
  const server = serve(fixture({}));
  await server.ready();
}
