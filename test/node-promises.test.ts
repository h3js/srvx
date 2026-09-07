import { createServer } from "node:http";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { serve, toNodeHandler } from "../src/adapters/node.ts";
import type { FetchHandler, NodeHttp1Handler } from "../src/types.ts";

const NativePromise = Promise;
afterEach(() => vi.unstubAllGlobals());

// Like Zone.js, a replacement constructor does not own native async results.
class ReplacementPromise<T> extends NativePromise<T> {}

for (const adapter of ["serve", "toNodeHandler"] as const) {
  describe(`${adapter} promise responses`, () => {
    for (const kind of ["native", "cross-realm", "sync", "non-callable-then"] as const) {
      test(`handles ${kind} responses with a replaced global Promise`, async () => {
        vi.stubGlobal("Promise", ReplacementPromise);
        const response = () =>
          kind === "non-callable-then"
            ? Object.assign(new Response("ok"), { then: undefined })
            : new Response("ok");
        const handler: FetchHandler =
          kind === "sync" || kind === "non-callable-then"
            ? response
            : kind === "native"
              ? async () => response()
              : () => runInNewContext("Promise.resolve(response())", { response });
        if (kind === "native")
          expect(handler(new Request("http://localhost"))).not.toBeInstanceOf(Promise);
        if (adapter === "serve") {
          const server = serve({ port: 0, hostname: "127.0.0.1", silent: true, fetch: handler });
          await server.ready();
          try {
            await check(server.url!);
          } finally {
            await server.close(true);
          }
        } else {
          const server = createServer(toNodeHandler(handler) as NodeHttp1Handler);
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing address");
            await check(`http://127.0.0.1:${address.port}`);
          } finally {
            server.closeAllConnections();
            await new NativePromise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
      });
    }
  });
}

for (const customError of [false, true]) {
  test(`handles native rejections with replaced Promise (error handler: ${customError})`, async () => {
    vi.stubGlobal("Promise", ReplacementPromise);
    const error = vi.fn(() => new Response("handled", { status: 503 }));
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      fetch: async () => {
        throw new Error("expected rejection");
      },
      ...(customError ? { error } : {}),
    });
    await server.ready();
    try {
      const response = await fetch(server.url!, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(customError ? 503 : 500);
      expect(await response.text()).toBe(customError ? "handled" : "");
      expect(error).toHaveBeenCalledTimes(customError ? 1 : 0);
    } finally {
      await server.close(true);
    }
  });
}

// A handler that returns a non-object must stay on the sync path and get the
// send layer's 500 — probing `then` with `in` instead threw a TypeError out of
// the node:http listener, taking the process down on `--unhandled-rejections`.
for (const result of [undefined, null, "not a response"] as const) {
  test(`answers 500 for a handler returning ${JSON.stringify(result)}`, async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      fetch: (() => result) as unknown as FetchHandler,
    });
    await server.ready();
    try {
      const response = await fetch(server.url!, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(500);
    } finally {
      await server.close(true);
    }
  });
}

async function check(url: string) {
  for (let i = 0; i < 3; i++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  }
}
