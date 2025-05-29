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
  let abortCount = 0;

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

    async error(err) {
      return new _Response(`error: ${(err as Error).message}`, { status: 500 });
    },

    async fetch(req) {
      const url = new URL(req.url);
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
          return new _Response(req instanceof Request ? "yes" : "no");
        }
        case "/req-headers-instanceof": {
          return new _Response(req.headers instanceof Headers ? "yes" : "no");
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
          req.signal.addEventListener("abort", () => {
            abortCount++;
          });
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
        case "/abort-count": {
          return _Response.json({ abortCount });
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
