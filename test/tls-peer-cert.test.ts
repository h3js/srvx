import { describe, beforeAll, afterAll, expect, test } from "vitest";
import { fetch, Agent } from "undici";
import { getTLSCert } from "./_utils.ts";
import { fixture } from "./_fixture.ts";
import { serve as nodeServe } from "../src/adapters/node.ts";
import { serve as denoServe } from "../src/adapters/deno.ts";

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

describe("mTLS peer certificate (Node adapter)", () => {
  let server: Awaited<ReturnType<typeof nodeServe>> | undefined;

  beforeAll(async () => {
    server = nodeServe(
      fixture({
        port: 0,
        tls: {
          cert: tls.cert,
          key: tls.key,
          ca: tls.ca,
          requestCert: true,
          // Inspect the certificate even when self-presented/unauthorized.
          rejectUnauthorized: false,
        },
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

test("non-TLS request has no request.tls", async () => {
  const server = nodeServe(fixture({ port: 0 }));
  await server.ready();
  try {
    const res = await fetch(server.url! + "tls");
    expect(await res.json()).toMatchObject({ hasTls: false });
  } finally {
    await server.close(true);
  }
});

test("native Deno server rejects mutual TLS and points to the Node adapter", () => {
  // `Deno.serve` cannot request client certificates; the adapter must fail loudly instead of silently ignoring `requestCert`.
  expect(() =>
    denoServe(
      fixture({
        manual: true,
        port: 0,
        tls: { cert: tls.cert, key: tls.key, ca: tls.ca, requestCert: true },
      }),
    ),
  ).toThrow(/srvx\/node/);
});
