import net from "node:net";
import { describe, expect, test } from "vitest";
import { serve } from "../src/adapters/node.ts";
import type { ServerRequest } from "../src/types.ts";

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
