import { describe, beforeAll, afterAll, expect, test, vi } from "vitest";
import { fetch, Agent } from "undici";
import { getTLSCert } from "./_utils.ts";
import { fixture } from "./_fixture.ts";
import { serve as nodeServe } from "../src/adapters/node.ts";
import { serve as denoServe } from "../src/adapters/deno.ts";
import { mtls } from "../src/mtls.ts";

const tls = await getTLSCert();

// undici dispatcher presenting a client certificate (mutual TLS).
function clientAgent(opts: { withClientCert: boolean }) {
  return new Agent({
    connect: {
      ca: tls.ca,
      ...(opts.withClientCert ? { cert: tls.clientCert, key: tls.clientKey } : {}),
    },
  });
}

// Skipped under a real Bun runtime: mtls() unconditionally refuses to start
// on Bun (see the throw test below), so `beforeAll` would fail before any of
// these sub-tests could run.
describe.skipIf(typeof Bun !== "undefined")("mtls() plugin (Node adapter)", () => {
  let server: Awaited<ReturnType<typeof nodeServe>> | undefined;

  beforeAll(async () => {
    server = nodeServe(
      fixture({
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        plugins: [
          mtls({
            ca: tls.ca,
            // Inspect the certificate even when self-presented/unauthorized.
            rejectUnauthorized: false,
          }),
        ],
      }),
    );
    await server!.ready();
  });

  afterAll(async () => {
    await server!.close(true);
  });

  const url = (path: string) => {
    const u = new URL(server!.url!);
    u.hostname = "localhost"; // match the server cert's altname
    return u.href + path.slice(1);
  };

  test("exposes the client certificate when presented", async () => {
    const dispatcher = clientAgent({ withClientCert: true });
    try {
      const res = await fetch(url("/tls"), { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        hasTls: true,
        subjectCN: "Test Client",
        issuerCN: "Test CA",
        authorized: true,
        protocol: expect.stringMatching(/^TLSv1\./),
      });
    } finally {
      await dispatcher.close();
    }
  });

  test("request.tls present without a client cert (empty peer cert)", async () => {
    const dispatcher = clientAgent({ withClientCert: false });
    try {
      const res = await fetch(url("/tls"), { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        hasTls: true,
        subjectCN: null, // no peer certificate -> empty object
        authorized: false,
        protocol: expect.stringMatching(/^TLSv1\./),
      });
    } finally {
      await dispatcher.close();
    }
  });
});

test("request.tls is absent without the mtls() plugin", async () => {
  const server = nodeServe(fixture({ port: 0 }));
  await server.ready();
  try {
    const res = await fetch(server.url! + "tls");
    expect(await res.json()).toMatchObject({ hasTls: false });
  } finally {
    await server.close(true);
  }
});

test("mtls() throws when TLS is not configured", () => {
  // On a real Bun runtime, the Bun-support guard fires unconditionally before
  // the TLS-config check (see below), so the thrown message differs there.
  const expected = typeof Bun !== "undefined" ? /not available on Bun/ : /HTTPS server/;
  expect(() =>
    nodeServe(fixture({ manual: true, port: 0, plugins: [mtls({ ca: tls.ca })] })),
  ).toThrow(expected);
});

test("mtls() throws on the native Deno adapter and points to srvx/node", () => {
  // The native `Deno.serve` cannot expose client certificates, so the plugin must
  // fail loudly instead of silently leaving `request.tls` empty.
  expect(() =>
    denoServe(
      fixture({
        manual: true,
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        plugins: [mtls({ ca: tls.ca })],
      }),
    ),
  ).toThrow(/srvx\/node/);
});

test("mtls() throws when running under Bun, even with TLS configured", () => {
  // Verified against the real Bun runtime separately (`bun --bun vitest`):
  // Bun's node:http(s) compat does not expose the peer certificate to the
  // handler (https://github.com/oven-sh/bun/issues/16254), so this guard must
  // fire regardless of TLS config. Simulated here via a stubbed global so the
  // assertion runs (and can regress) under Node/CI without a real Bun binary.
  if (typeof Bun !== "undefined") {
    return; // Already exercising the real thing; avoid double-stubbing globalThis.Bun.
  }
  vi.stubGlobal("Bun", {});
  try {
    expect(() =>
      nodeServe(
        fixture({
          manual: true,
          port: 0,
          tls: { cert: tls.cert, key: tls.key },
          plugins: [mtls({ ca: tls.ca })],
        }),
      ),
    ).toThrow(/not available on Bun/);
  } finally {
    vi.unstubAllGlobals();
  }
});
