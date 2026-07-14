import { afterEach, describe, expect, test } from "vitest";
import { serve } from "../src/adapters/node.ts";

// F9 (error paths): with no `error` option the `errorPlugin` no-ops and handler
// exceptions propagate to the runtime. This documents the *actual* Node
// behavior (see `test/_error-tests.ts` for the Deno/Bun counterparts, which
// answer 500 and stay alive).
//
// Node currently lets an unhandled throw escape the request handler as a
// process-level `uncaughtException`/`unhandledRejection` and sends no response
// on that connection -- i.e. an unguarded server would crash. We install a
// temporary handler to capture it (preventing the vitest worker from dying) and
// assert the observed behavior + that the server keeps serving afterwards.
// Fixing the divergence (making Node answer 500 like Deno/Bun) belongs to the
// Node adapter scope, not this edge-adapter batch.
describe("node adapter unhandled errors (F9)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  async function withServer(
    handler: (req: Request) => Response | Promise<Response>,
    fn: (url: string) => Promise<void>,
  ) {
    const server = serve({ hostname: "localhost", port: 0, fetch: handler });
    await server.ready();
    try {
      await fn(server.url!);
    } finally {
      await server.close(true);
    }
  }

  test("sync throw escapes as uncaughtException and does not silently succeed", async () => {
    const captured: unknown[] = [];
    const onUncaught = (err: unknown) => captured.push(err);
    process.prependListener("uncaughtException", onUncaught);
    restore = () => process.removeListener("uncaughtException", onUncaught);

    await withServer(
      (req) => {
        if (new URL(req.url).pathname === "/throw") {
          throw new Error("unhandled sync error");
        }
        return new Response("ok");
      },
      async (url) => {
        // The throwing request gets no proper response: Node leaves the socket
        // hanging (and surfaces the throw as an uncaughtException), so the fetch
        // never completes -- bound it with a short timeout. Either way it must
        // NOT be a silent 2xx.
        const status = await fetch(url + "throw", { signal: AbortSignal.timeout(1000) })
          .then((r) => r.status)
          .catch(() => undefined);
        // Give the event loop a tick for the uncaughtException to fire.
        await new Promise((r) => setTimeout(r, 50));

        const uncaught = captured.some((e) => (e as Error)?.message === "unhandled sync error");
        expect(uncaught || (status !== undefined && status >= 500)).toBe(true);

        // The server itself survives (we swallowed the exception): a normal
        // request still succeeds.
        const ok = await fetch(url);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("ok");
      },
    );
  });
});
