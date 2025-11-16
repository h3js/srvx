import { inspect } from "node:util";
import type { ServerOptions } from "../src/types.ts";

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
          const clone = new Request(req);
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
          return new _Response(
            new Readable({
              read() {
                for (let i = 0; i < 3; i++) {
                  this.push(`chunk${i}\n`);
                }
                this.push(null /* end stream */);
              },
            }) as any,
          );
        }
        case "/clone-response": {
          const res = new _Response("", {});
          if (req.headers.get("x-clone-with-headers") === "true") {
            res.headers.set("x-clone-with-headers", "true");
          }
          return res.clone();
        }
        case "/abort": {
          return new _Response(
            new ReadableStream({
              async start(controller) {
                while (!req.signal.aborted) {
                  controller.enqueue(
                    new TextEncoder().encode(new Date().toISOString() + "\n"),
                  );
                  await new Promise((resolve) => setTimeout(resolve, 100));
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
        case "/response/stream-error": {
          const encoder = new TextEncoder();
          return new _Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode("chunk1\n"));
                await new Promise((resolve) => setTimeout(resolve, 100));
                controller.enqueue(encoder.encode("chunk2\n"));
                await new Promise((resolve) => setTimeout(resolve, 100));
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
      }
      return new _Response("404", { status: 404 });
    },
  };
};

if (import.meta.main) {
  const server = serve(fixture({}));
  await server.ready();
}
