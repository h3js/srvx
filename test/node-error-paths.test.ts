import { afterEach, describe, expect, test } from "vitest";
import { serve } from "../src/adapters/node.ts";
import { addExecUnhandledThrowTests } from "./_error-tests.ts";

// F9 (error paths): with no `error` option the `errorPlugin` no-ops, so the
// adapter itself is the last line of defense for a handler that fails. It
// answers a bare 500 and keeps serving, matching the Bun/Deno runtimes (see
// `test/_error-tests.ts` for those counterparts).
//
// Before #244 the failure escaped the request listener as a process-level
// `uncaughtException`/`unhandledRejection` -- fatal for an unguarded process --
// and left the client socket hanging until it timed out. Each test captures
// process-level errors to assert none escape.
describe("node adapter unhandled errors (F9)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** Captures (and swallows) process-level errors raised during the test. */
  function captureProcessErrors(event: "uncaughtException" | "unhandledRejection"): unknown[] {
    const captured: unknown[] = [];
    const onError = (error: unknown) => captured.push(error);
    process.prependListener(event, onError);
    restore = () => process.removeListener(event, onError);
    return captured;
  }

  async function withServer(
    handler: (req: Request) => Response | Promise<Response>,
    fn: (url: string) => Promise<void>,
  ) {
    // `silent` also gates the adapter's error log: these throws are intentional
    // and would only add noise to the vitest output.
    const server = serve({ hostname: "localhost", port: 0, silent: true, fetch: handler });
    await server.ready();
    try {
      await fn(server.url!);
    } finally {
      await server.close(true);
    }
  }

  for (const [name, event, fail] of [
    [
      "sync throw",
      "uncaughtException",
      () => {
        throw new Error("unhandled sync error");
      },
    ],
    [
      "async rejection",
      "unhandledRejection",
      () => Promise.reject(new Error("unhandled async error")),
    ],
  ] as const) {
    test(`${name} answers 500 without escaping as ${event}`, async () => {
      const captured = captureProcessErrors(event);

      await withServer(
        (req) => (new URL(req.url).pathname === "/throw" ? fail() : new Response("ok")),
        async (url) => {
          // Bounded: a regression leaves the socket hanging rather than failing
          // fast, so without a timeout this would stall for ~1.5s and report as
          // a fetch failure rather than a 500 mismatch.
          const res = await fetch(url + "throw", { signal: AbortSignal.timeout(1000) });
          expect(res.status).toBe(500);
          // Bare 500: no error details leak to the client.
          expect(await res.text()).toBe("");

          // Give the event loop a tick for a process-level error to surface.
          await new Promise((r) => setTimeout(r, 50));
          expect(captured).toEqual([]);

          // The server keeps serving: a normal request still succeeds.
          const ok = await fetch(url);
          expect(ok.status).toBe(200);
          expect(await ok.text()).toBe("ok");
        },
      );
    });
  }
});

// The in-process tests above run inside vitest, which installs its own
// process-level error handlers -- so they can prove no error escapes, but not
// that an *unguarded* process survives one. Spawn the shared fixture to check
// that, against the same assertions Deno and Bun are held to.
describe("node (unhandled errors)", () => {
  addExecUnhandledThrowTests("node ./_error-fixture.ts");
});
