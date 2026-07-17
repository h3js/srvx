import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerMiddleware, ServerRequest } from "../src/types.ts";

const ESC = /\[\d+m/;

/**
 * `cli/_utils.ts` decides on colors at module scope, so the environment has to be
 * in place before `src/log.ts` is (re)imported for each case.
 *
 * `tty` makes `cli/_utils.ts` consider stdout color-capable, which is what a
 * container started with a tty looks like. Without it stdout is a pipe under
 * vitest and colors are already off, so the production case would pass for the
 * wrong reason.
 */
async function withLog(
  env: Record<string, string>,
  run: (log: (options?: any) => ServerMiddleware) => Promise<void>,
  { tty = false }: { tty?: boolean } = {},
): Promise<string[]> {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  if (tty) {
    vi.stubEnv("TERM", "xterm-256color");
  }

  const isTTY = process.stdout.isTTY;
  const write = process.stdout.write;
  const chunks: string[] = [];
  try {
    process.stdout.isTTY = tty;
    vi.resetModules();
    const { log } = await import("../src/log.ts");

    process.stdout.write = ((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof write;

    await run(log);
    // Lines are flushed on the next check phase; give it two turns to land.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
  }
  return chunks;
}

const request = (url = "http://localhost/", method = "GET") =>
  new Request(url, { method }) as ServerRequest;

const respond = (status: number) => () => new Response("", { status });

// `Response` refuses 1xx, so the status→color mapping is exercised against a
// stub; the middleware only ever reads `.status`.
const respondWith = (status: number) => () => ({ status }) as Response;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("log", () => {
  it("logs method, url, status and duration", async () => {
    const chunks = await withLog({ NODE_ENV: "production" }, async (log) => {
      const middleware = log();
      await middleware(request("http://localhost/hello"), respond(200));
    });

    expect(chunks.join("")).toMatch(
      /^\[\d{1,2}:\d{2}:\d{2}(\s| )?(AM|PM)?\] GET http:\/\/localhost\/hello \[200\] \(\d+\.\d{2}ms\)\n$/,
    );
  });

  it("passes the response through untouched", async () => {
    let response: Response | undefined;
    await withLog({ NODE_ENV: "production" }, async (log) => {
      const original = new Response("body", { status: 201 });
      response = (await log()(request(), () => original)) as Response;
      expect(response).toBe(original);
    });
    expect(await response!.text()).toBe("body");
  });

  it("emits no colors in production, even on a color-capable stdout", async () => {
    const chunks = await withLog(
      { NODE_ENV: "production" },
      async (log) => {
        const middleware = log();
        await middleware(request(), respond(200));
        await middleware(request(), respond(500));
      },
      { tty: true },
    );

    const output = chunks.join("");
    // Assert on real content first: an empty capture would satisfy `not.toMatch`.
    expect(output).toContain("[200]");
    expect(output).toContain("[500]");
    expect(output).not.toMatch(ESC);
  });

  it("emits colors outside production", async () => {
    const chunks = await withLog(
      { NODE_ENV: "development" },
      async (log) => {
        await log()(request(), respond(200));
      },
      { tty: true },
    );

    expect(chunks.join("")).toMatch(ESC);
  });

  it("lets FORCE_COLOR override the production default", async () => {
    const chunks = await withLog({ NODE_ENV: "production", FORCE_COLOR: "1" }, async (log) => {
      await log()(request(), respond(200));
    });

    expect(chunks.join("")).toMatch(ESC);
  });

  it("colors the status by its leading digit", async () => {
    const chunks = await withLog({ NODE_ENV: "development", FORCE_COLOR: "1" }, async (log) => {
      const middleware = log();
      for (const status of [101, 200, 302, 404, 500]) {
        await middleware(request(), respondWith(status));
      }
    });
    const lines = chunks.join("").trimEnd().split("\n");

    expect(lines[0]).toContain("[[34m101[39m]"); // 1xx blue
    expect(lines[1]).toContain("[[32m200[39m]"); // 2xx green
    expect(lines[2]).toContain("[[33m302[39m]"); // 3xx yellow
    expect(lines[3]).toContain("[[31m404[39m]"); // 4xx red
    expect(lines[4]).toContain("[[31m500[39m]"); // 5xx red
  });

  it("coalesces lines logged in the same turn into a single write", async () => {
    const chunks = await withLog({ NODE_ENV: "production" }, async (log) => {
      const middleware = log();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          middleware(request(`http://localhost/${i}`), respond(200)),
        ),
      );
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.trimEnd().split("\n")).toHaveLength(20);
  });

  it("preserves order across writes", async () => {
    const chunks = await withLog({ NODE_ENV: "production" }, async (log) => {
      const middleware = log();
      for (const i of [0, 1, 2]) {
        await middleware(request(`http://localhost/${i}`), respond(200));
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    const lines = chunks.join("").trimEnd().split("\n");

    expect(lines.map((line) => line.match(/(http:\S+)/)?.[1])).toEqual([
      "http://localhost/0",
      "http://localhost/1",
      "http://localhost/2",
    ]);
  });
});
