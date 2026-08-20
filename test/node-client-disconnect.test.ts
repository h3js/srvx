import net from "node:net";
import http2 from "node:http2";
import { describe, expect, test } from "vitest";
import { serve } from "../src/adapters/node.ts";
import { getTLSCert } from "./_utils.ts";
import type { ServerRequest } from "../src/types.ts";

// HTTP/2 is not implemented in the Deno/Bun node-compat layers we test against.
// https://github.com/h3js/srvx/issues/237
const skipHttp2 = !!globalThis.Deno || !!globalThis.Bun;

type ReadOutcome = {
  /** Rejection from the body read, if any. */
  error?: any;
  /** `request.signal.aborted`, sampled *after* the read (see below). */
  aborted?: boolean;
  /** Set when the read never settled. */
  timedOut?: true;
};

/**
 * Serves one request whose client promises more body than it delivers and then
 * destroys the socket, and reports what `read()` did once the request stream is
 * gone.
 *
 * `signal` is deliberately untouched until after the read: srvx creates the
 * `AbortController` lazily, so this is also the case where the `close` that
 * carries the disconnect fires before any listener exists.
 */
async function readAfterDisconnect(
  read: (request: ServerRequest) => Promise<unknown>,
): Promise<ReadOutcome> {
  let settle!: (outcome: ReadOutcome) => void;
  const outcome = new Promise<ReadOutcome>((resolve) => (settle = resolve));

  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    async fetch(request) {
      const req = request.runtime!.node!.req;
      // Read only once the client is really gone -- the state the handler sees
      // when a disconnect lands while it is awaiting something else.
      for (let i = 0; i < 200 && !req.destroyed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        await read(request);
        settle({ aborted: request.signal.aborted });
      } catch (error) {
        settle({ error, aborted: request.signal.aborted });
      }
      return new Response("ok");
    },
  });
  await server.ready();

  try {
    const { port } = server.node!.server!.address() as net.AddressInfo;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial");
      setTimeout(() => socket.destroy(), 20);
    });
    socket.on("error", () => {});
    // A read that hangs must fail as an assertion, not as a suite timeout.
    return await Promise.race([
      outcome,
      new Promise<ReadOutcome>((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000)),
    ]);
  } finally {
    await server.close(true);
  }
}

// https://github.com/h3js/srvx/issues/293
//
// `Readable.toWeb()` hands back an already-cancelled (and therefore disturbed)
// stream once the source is destroyed, so materializing the native Request over
// it threw undici's bare `TypeError: Response body object should not be
// disturbed or locked` -- indistinguishable from a malformed request, so callers
// answered 5xx for every cancelled request. The buffered `text()`/`json()` path
// was worse: it re-listened to a stream that would never emit again and the
// handler hung forever.
describe("node client disconnect before a body read (#293)", () => {
  for (const method of ["arrayBuffer", "bytes", "blob", "formData", "text", "json"] as const) {
    test(`${method}() rejects with the abort reason`, async () => {
      const { error, aborted, timedOut } = await readAfterDisconnect((request) =>
        request[method](),
      );
      expect(timedOut).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toMatch(/disturbed or locked/);
      // The socket error srvx also aborts the signal with, so `err ===
      // request.signal.reason` identifies a client disconnect.
      expect(error.code).toBe("ECONNRESET");
      expect(aborted).toBe(true);
    });
  }

  test("body stream errors with the abort reason", async () => {
    const { error, aborted, timedOut } = await readAfterDisconnect(async (request) => {
      const reader = request.body!.getReader();
      return reader.read();
    });
    expect(timedOut).toBeUndefined();
    // Previously the pre-cancelled stream read as a clean `{ done: true }`: a
    // truncated body indistinguishable from an empty one.
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ECONNRESET");
    expect(aborted).toBe(true);
  });

  test("the rejection is the abort reason", async () => {
    let reason: unknown;
    const { error, timedOut } = await readAfterDisconnect((request) => {
      reason = request.signal.reason;
      return request.text();
    });
    expect(timedOut).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBe(reason);
  });

  test("a destroy without an error during a buffered read still settles", async () => {
    let settle!: (outcome: ReadOutcome) => void;
    const outcome = new Promise<ReadOutcome>((resolve) => (settle = resolve));
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
      async fetch(request) {
        const req = request.runtime!.node!.req;
        // A bare `destroy()` emits no `error`, so only `close` can settle the
        // read that is already in flight. The response never reaches the client
        // (the socket goes with it), hence the in-process handshake.
        setTimeout(() => req.destroy(), 20);
        try {
          await request.text();
          settle({});
        } catch (error) {
          settle({ error });
        }
        return new Response("ok");
      },
    });
    await server.ready();
    try {
      const { port } = server.node!.server!.address() as net.AddressInfo;
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial");
      });
      socket.on("error", () => {});
      const { error, timedOut } = await Promise.race([
        outcome,
        new Promise<ReadOutcome>((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000)),
      ]);
      socket.destroy();
      expect(timedOut).toBeUndefined();
      expect(error.name).toBe("AbortError");
    } finally {
      await server.close(true);
    }
  });
});

/**
 * The HTTP/2 counterpart of `readAfterDisconnect()`: one request whose client
 * promises more body than it delivers and then destroys the stream.
 *
 * `Http2ServerRequest` reaches the same situation from the opposite direction, so
 * none of the HTTP/1 state the fix keys off applies:
 *
 * | after a client hangs up mid-body | HTTP/1 | HTTP/2 |
 * | -------------------------------- | ------ | ------ |
 * | `req.destroyed`                  | true   | false (`autoDestroy: false`) |
 * | `req.complete`                   | false  | **true** (the getter ORs in `aborted`) |
 * | `req.errored`                    | the socket error | null (`onStreamError` is a no-op) |
 * | `req.aborted`                    | true   | true |
 *
 * `waitFor` decides whether the handler reads *after* the client is already gone
 * (the state a handler awaiting something else lands in) or starts the read while
 * the body is still arriving and is overtaken by the disconnect.
 */
async function readAfterDisconnectHttp2(
  read: (request: ServerRequest) => Promise<unknown>,
  waitFor: "disconnect" | "none" = "disconnect",
): Promise<ReadOutcome> {
  const tls = await getTLSCert();
  let settle!: (outcome: ReadOutcome) => void;
  const outcome = new Promise<ReadOutcome>((resolve) => (settle = resolve));

  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    tls,
    node: { http2: true, allowHTTP1: false } as any,
    async fetch(request) {
      const req = request.runtime!.node!.req;
      if (waitFor === "disconnect") {
        // `aborted` is the only flag that moves on HTTP/2 (see the table above).
        for (let i = 0; i < 200 && !req.aborted; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      try {
        await read(request);
        settle({ aborted: request.signal.aborted });
      } catch (error) {
        settle({ error, aborted: request.signal.aborted });
      }
      return new Response("ok");
    },
  });
  await server.ready();

  const client = http2.connect(server.url!, { ca: tls.ca, servername: "localhost" });
  client.on("error", () => {});
  try {
    const stream = client.request({ ":method": "POST", ":path": "/", "content-length": 100 });
    stream.on("error", () => {});
    stream.resume();
    stream.write("partial");
    // Not on the same tick as the headers: an immediate RST is dropped before the
    // server ever dispatches a request, so there would be no handler to observe.
    setTimeout(() => stream.destroy(), 40);
    // A read that hangs must fail as an assertion, not as a suite timeout.
    return await Promise.race([
      outcome,
      new Promise<ReadOutcome>((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000)),
    ]);
  } finally {
    client.destroy();
    await server.close(true);
  }
}

// https://github.com/h3js/srvx/issues/293 — the HTTP/2 half.
//
// The HTTP/1 fix above is keyed off `req.destroyed` / `req.errored` / `!req.complete`,
// none of which ever hold on `Http2ServerRequest`, so every mode it closes was
// still open on HTTP/2 — plus one that HTTP/1 does not have: because the compat
// layer signals a hang-up by pushing EOF onto the request stream rather than
// destroying it, a buffered read that was already in flight *resolved with the
// bytes that made it*, handing the handler a silently truncated body.
describe.skipIf(skipHttp2)("http2 client disconnect before a body read (#293)", () => {
  for (const method of ["arrayBuffer", "bytes", "blob", "formData", "text", "json"] as const) {
    test(`${method}() rejects with the abort reason`, async () => {
      const { error, aborted, timedOut } = await readAfterDisconnectHttp2((request) =>
        request[method](),
      );
      // `text()`/`json()` used to hang: the compat layer had already pushed EOF
      // and dumped the buffered bytes, so re-listening heard nothing ever again.
      expect(timedOut).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      // The rest used to reject with a bare "Body is unusable" / "disturbed or
      // locked" TypeError, which says nothing about a disconnect.
      expect(error.name).toBe("AbortError");
      expect(error.message).not.toMatch(/disturbed or locked/);
      expect(aborted).toBe(true);
    });
  }

  test("body stream errors with the abort reason", async () => {
    const { error, aborted, timedOut } = await readAfterDisconnectHttp2(async (request) => {
      const reader = request.body!.getReader();
      return reader.read();
    });
    expect(timedOut).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(aborted).toBe(true);
  });

  test("the rejection is the abort reason", async () => {
    let reason: unknown;
    const { error, timedOut } = await readAfterDisconnectHttp2((request) => {
      reason = request.signal.reason;
      return request.text();
    });
    expect(timedOut).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBe(reason);
  });

  test("a buffered read in flight rejects instead of resolving truncated", async () => {
    const { error, aborted, timedOut } = await readAfterDisconnectHttp2(
      (request) => request.text(),
      "none",
    );
    expect(timedOut).toBeUndefined();
    // Previously this resolved with "partial" -- the 7 bytes that arrived out of
    // the 100 the client promised, indistinguishable from a complete body.
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(aborted).toBe(true);
  });

  test("a streamed read in flight errors instead of ending cleanly", async () => {
    const chunks: number[] = [];
    const { error, aborted, timedOut } = await readAfterDisconnectHttp2(async (request) => {
      const reader = request.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        chunks.push(value.length);
      }
    }, "none");
    expect(timedOut).toBeUndefined();
    // A truncated body must not read as a clean `{ done: true }`.
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(aborted).toBe(true);
  });
});
