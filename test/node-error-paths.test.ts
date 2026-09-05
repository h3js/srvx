import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { FastResponse, serve, toNodeHandler } from "../src/adapters/node.ts";
import type { NodeHttp1Handler, ServerRequest } from "../src/types.ts";
import { addExecUnhandledThrowTests } from "./_error-tests.ts";

// Shared by the suites below: each captures process-level errors to assert that
// none escape the adapter.
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
  handler: (req: ServerRequest) => Response | Promise<Response>,
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

// F9 (error paths): with no `error` option the `errorPlugin` no-ops, so the
// adapter itself is the last line of defense for a handler that fails. It
// answers a bare 500 and keeps serving, matching the Bun/Deno runtimes (see
// `test/_error-tests.ts` for those counterparts).
//
// Before #244 the failure escaped the request listener as a process-level
// `uncaughtException`/`unhandledRejection` -- fatal for an unguarded process --
// and left the client socket hanging until it timed out.
describe("node adapter unhandled errors (F9)", () => {
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

// https://github.com/h3js/srvx/issues/290: a malformed response must not be able
// to escalate to a process exit, and the recovery path must not be able to throw.
describe("node adapter malformed responses (#290)", () => {
  const injected = "OK\r\nX-Inj: pwned";

  test("invalid statusText is sanitized instead of crashing", async () => {
    const captured = captureProcessErrors("uncaughtException");

    await withServer(
      () => new FastResponse("body", { statusText: injected }),
      async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("body");
        // CR/LF stripped from the reason phrase, so the trailer can't be parsed
        // as a header of its own (response splitting).
        expect(res.statusText).toBe("OKX-Inj: pwned");
        expect(res.headers.get("x-inj")).toBe(null);

        await new Promise((r) => setTimeout(r, 50));
        expect(captured).toEqual([]);
      },
    );
  });

  // `writeHead` assigns `statusMessage` before validating it, so a failed call
  // leaves the bad value behind. Before the fix `failResponse()` reset only the
  // status code, and its `end()` threw ERR_INVALID_CHAR a second time -- out of
  // the catch that was supposed to contain it.
  test("recovery survives a poisoned statusMessage", async () => {
    const captured = captureProcessErrors("uncaughtException");

    await withServer(
      (req) => {
        if (new URL(req.url).pathname === "/throw") {
          req.runtime!.node!.res!.statusMessage = injected;
          throw new Error("unhandled error after poisoning statusMessage");
        }
        return new Response("ok");
      },
      async (url) => {
        const res = await fetch(url + "throw", { signal: AbortSignal.timeout(1000) });
        expect(res.status).toBe(500);
        // Reset to empty, so Node fills in the phrase for the new status code.
        expect(res.statusText).toBe("Internal Server Error");
        expect(res.headers.get("x-inj")).toBe(null);
        expect(await res.text()).toBe("");

        await new Promise((r) => setTimeout(r, 50));
        expect(captured).toEqual([]);

        // The server keeps serving.
        expect((await fetch(url)).status).toBe(200);
      },
    );
  });

  // node:http ignores the request listener's return value, so a rejection from
  // `sendNodeResponse` has no consumer and would surface as a fatal
  // `unhandledRejection` -- the `serve()` path answers 500 for the same failure.
  test("toNodeHandler answers 500 for an unserializable response", async () => {
    const captured = captureProcessErrors("unhandledRejection");

    const server = createServer(
      toNodeHandler(() => new FastResponse("x", { status: 99 })) as NodeHttp1Handler,
    );
    // Intentional failure: silence the adapter's diagnostic for this test.
    const consoleError = console.error;
    console.error = () => {};
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");

      await new Promise((r) => setTimeout(r, 50));
      expect(captured).toEqual([]);
    } finally {
      console.error = consoleError;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// The in-process tests above run inside vitest, which installs its own
// process-level error handlers -- so they can prove no error escapes, but not
// that an *unguarded* process survives one. Spawn the shared fixture to check
// that, against the same assertions Deno and Bun are held to.
describe("node (unhandled errors)", () => {
  addExecUnhandledThrowTests("node ./_error-fixture.ts");
});
