import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { execa, type ResultPromise } from "execa";
import { getRandomPort } from "get-port-please";
import { serve } from "../src/adapters/scriptc.ts";
import type { Server, ServerOptions } from "../src/types.ts";
import { waitForServer } from "./_utils.ts";

// The adapter only uses `node:http` and the web globals, so it runs under
// Node.js as-is. These tests cover its behavior there; the `SCRIPTC` suite at
// the end compiles a small app to a native executable and checks it end to end.

// `fetch` normalizes the request target and host, so send these with node:http.
function rawRequest(port: number, path: string, headers?: Record<string, string>) {
  return new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function startServer(options: Partial<ServerOptions> & Pick<ServerOptions, "fetch">) {
  const server = serve({ port: 0, hostname: "127.0.0.1", silent: true, ...options });
  return server.ready() as Promise<Server>;
}

describe("scriptc adapter (node)", () => {
  let server: Server;
  let url: (path: string) => string;
  const errors: unknown[] = [];
  let lastRequest: Request | undefined;

  beforeAll(async () => {
    server = await startServer({
      middleware: [
        (req, next) => (req.headers.has("x-mw-short") ? new Response("from middleware") : next()),
      ],
      plugins: [
        (s) => {
          s.options.middleware.unshift(async (_req, next) => {
            const res = await next();
            res.headers.set("x-plugin", "1");
            return res;
          });
        },
      ],
      error: (error) => {
        if ((error as Error).message === "handled") {
          return new Response("handled error", { status: 503 });
        }
        throw error;
      },
      async fetch(req) {
        lastRequest = req;
        const { pathname } = new URL(req.url);
        switch (pathname) {
          case "/json": {
            return Response.json({ method: req.method, url: req.url });
          }
          case "/echo": {
            return new Response(await req.text(), {
              headers: { "x-method": req.method, "x-header": req.headers.get("x-test") || "" },
            });
          }
          case "/cookies": {
            const headers = new Headers({ "x-other": "1" });
            headers.append("set-cookie", "a=1; Path=/");
            headers.append("set-cookie", "b=2; Path=/");
            return new Response("cookies", { headers });
          }
          case "/status": {
            return new Response("teapot", { status: 418, statusText: "Short And Stout" });
          }
          case "/no-content": {
            return new Response(null, { status: 204 });
          }
          case "/stream": {
            const encoder = new TextEncoder();
            let i = 0;
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  await new Promise((r) => setTimeout(r, 5));
                  if (i++ < 3) controller.enqueue(encoder.encode(`chunk${i}\n`));
                  else controller.close();
                },
              }),
            );
          }
          case "/stream-error": {
            return new Response(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error("stream error"));
                },
              }),
              { headers: { "x-from-handler": "1" } },
            );
          }
          case "/handled-error": {
            throw new Error("handled");
          }
          case "/unhandled-error": {
            throw new Error("unhandled");
          }
          case "/abort": {
            return new Promise<Response>((resolve) => {
              req.signal.addEventListener("abort", () => {
                errors.push("aborted");
                resolve(new Response("aborted"));
              });
            });
          }
        }
        return new Response("ok");
      },
    });
    url = (path) => new URL(path, server.url).href;
  });

  afterAll(async () => {
    await server.close(true);
  });

  test("server shape", () => {
    expect(server.runtime).toBe("scriptc");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(typeof server.waitUntil).toBe("function");
  });

  test("GET text", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-plugin")).toBe("1");
    expect(await res.text()).toBe("ok");
  });

  test("passes method, url and headers to a native Request", async () => {
    const res = await fetch(url("/json?foo=bar"));
    expect(await res.json()).toEqual({ method: "GET", url: url("/json?foo=bar") });
    expect(lastRequest).toBeInstanceOf(Request);
    expect(lastRequest!.constructor).toBe(Request);
  });

  test("request extras are not attached", async () => {
    await fetch(url("/"));
    const req = lastRequest as Request & Record<string, unknown>;
    expect(req.ip).toBeUndefined();
    expect(req.waitUntil).toBeUndefined();
    expect(req.runtime).toBeUndefined();
  });

  test("POST echo", async () => {
    const res = await fetch(url("/echo"), {
      method: "POST",
      body: "hello",
      headers: { "x-test": "123" },
    });
    expect(res.headers.get("x-method")).toBe("POST");
    expect(res.headers.get("x-header")).toBe("123");
    expect(await res.text()).toBe("hello");
  });

  test("POST echo (1MB streamed body)", async () => {
    const body = "x".repeat(1024 * 1024);
    const res = await fetch(url("/echo"), { method: "PUT", body });
    const text = await res.text();
    expect(text.length).toBe(body.length);
    expect(text === body).toBe(true);
  });

  test("multiple set-cookie headers", async () => {
    const res = await fetch(url("/cookies"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.get("x-other")).toBe("1");
  });

  test("status and statusText", async () => {
    const res = await fetch(url("/status"));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("Short And Stout");
  });

  test("streaming response", async () => {
    const res = await fetch(url("/stream"));
    expect(await res.text()).toBe("chunk1\nchunk2\nchunk3\n");
  });

  test("HEAD has headers but no body", async () => {
    const res = await fetch(url("/stream"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-plugin")).toBe("1");
    expect(await res.text()).toBe("");
  });

  test("null body status", async () => {
    const res = await fetch(url("/no-content"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("middleware", async () => {
    const res = await fetch(url("/"), { headers: { "x-mw-short": "1" } });
    expect(await res.text()).toBe("from middleware");
  });

  test("error option handles thrown errors", async () => {
    const res = await fetch(url("/handled-error"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("handled error");
  });

  test("unhandled error answers 500", async () => {
    const res = await fetch(url("/unhandled-error"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });

  test("response stream error before first chunk answers a clean 500", async () => {
    const res = await fetch(url("/stream-error"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-from-handler")).toBeNull();
  });

  test("absolute-form request target", async () => {
    const port = Number(new URL(server.url!).port);
    const { status, body } = await rawRequest(port, "http://example.com/json?x=1");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ url: "http://example.com/json?x=1" });
  });

  test("protocol-relative path stays on the request host", async () => {
    const port = Number(new URL(server.url!).port);
    const res = await rawRequest(port, "//evil.example/json", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(lastRequest!.url).toBe(`http://127.0.0.1:${port}//evil.example/json`);
  });

  test("invalid host header answers 400", async () => {
    const port = Number(new URL(server.url!).port);
    const res = await rawRequest(port, "/json", { host: "evil.example/x?" });
    expect(res.status).toBe(400);
  });

  test("request.signal aborts when the client disconnects", async () => {
    const controller = new AbortController();
    const res = fetch(url("/abort"), { signal: controller.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await res;
    await expect.poll(() => errors.includes("aborted")).toBe(true);
  });
});

describe("scriptc adapter lifecycle (node)", () => {
  test("manual mode does not listen until serve()", async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      manual: true,
      fetch: () => new Response("ok"),
    });
    await expect(server.ready()).resolves.toBe(server);
    expect(server.url).toBeUndefined();
    await server.serve();
    expect(server.url).toBeDefined();
    expect(await (await fetch(server.url!)).text()).toBe("ok");
    await server.close();
    expect(server.url).toBeUndefined();
  });

  test("server.fetch runs middleware without a listener", async () => {
    const server = serve({
      manual: true,
      middleware: [async (_req, next) => new Response(`mw:${await (await next()).text()}`)],
      fetch: () => new Response("ok"),
    });
    const res = await server.fetch(new Request("http://localhost/"));
    expect(await res.text()).toBe("mw:ok");
  });

  test("close() awaits server.waitUntil tasks", async () => {
    let done = false;
    const server = await startServer({
      fetch: () => {
        server.waitUntil!(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              done = true;
              resolve();
            }, 30),
          ),
        );
        return new Response("ok");
      },
    });
    await fetch(server.url!);
    expect(done).toBe(false);
    await server.close();
    expect(done).toBe(true);
  });

  test("ready() rejects when the port is in use", async () => {
    const first = await startServer({ fetch: () => new Response("ok") });
    const port = Number(new URL(first.url!).port);
    const second = serve({
      port,
      hostname: "127.0.0.1",
      silent: true,
      fetch: () => new Response("ok"),
    });
    await expect(second.ready()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await first.close();
  });
});

// Opt-in: `SCRIPTC=/path/to/scriptc pnpm vitest run test/scriptc.test.ts`
// (needs `pnpm build`, the app imports the built `srvx/scriptc`).
const scriptc = process.env.SCRIPTC;
const pkgDir = fileURLToPath(new URL("..", import.meta.url));

describe.skipIf(!scriptc)("scriptc adapter (native executable)", () => {
  let dir: string;
  let child: ResultPromise | undefined;
  let base: string;

  beforeAll(async () => {
    if (!existsSync(join(pkgDir, "dist/adapters/scriptc.mjs"))) {
      throw new Error("Run `pnpm build` first.");
    }
    dir = await mkdtemp(join(tmpdir(), "srvx-scriptc-"));
    await mkdir(join(dir, "node_modules"));
    await symlink(pkgDir, join(dir, "node_modules/srvx"), "dir");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "app.ts"), scriptcApp);
    await execa(scriptc!, ["build", "app.ts", "-o", "app"], { cwd: dir });

    const port = await getRandomPort("127.0.0.1");
    base = `http://127.0.0.1:${port}`;
    child = execa(join(dir, "app"), [], { env: { PORT: String(port) }, reject: false });
    await waitForServer(port, child);
  }, 300_000);

  afterAll(async () => {
    child?.kill();
    await child;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("text + middleware", async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get("x-middleware")).toBe("1");
    expect(await res.text()).toBe("ok");
  });

  test("json", async () => {
    expect(await (await fetch(`${base}/json`)).json()).toEqual({ method: "GET" });
  });

  test("POST echo (1MB)", async () => {
    const body = "y".repeat(1024 * 1024);
    const text = await (await fetch(`${base}/echo`, { method: "POST", body })).text();
    expect(text === body).toBe(true);
  });

  test("multiple set-cookie", async () => {
    const res = await fetch(`${base}/cookies`);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("streaming response", async () => {
    expect(await (await fetch(`${base}/stream`)).text()).toBe("chunk1\nchunk2\nchunk3\n");
  });

  test("HEAD", async () => {
    const res = await fetch(`${base}/stream`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("thrown error answers 500", async () => {
    expect((await fetch(`${base}/throw`)).status).toBe(500);
  });
});

const scriptcApp = /* ts */ `
import { serve } from "srvx/scriptc";

serve({
  hostname: "127.0.0.1",
  silent: true,
  middleware: [
    async (_req, next) => {
      const res = await next();
      res.headers.set("x-middleware", "1");
      return res;
    },
  ],
  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/json":
        return Response.json({ method: req.method });
      case "/echo":
        return new Response(await req.text());
      case "/cookies": {
        const headers = new Headers();
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return new Response("cookies", { headers });
      }
      case "/stream": {
        const encoder = new TextEncoder();
        let i = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (i++ < 3) controller.enqueue(encoder.encode("chunk" + i + "\\n"));
              else controller.close();
            },
          }),
        );
      }
      case "/throw":
        throw new Error("boom");
    }
    return new Response("ok");
  },
});
`;
