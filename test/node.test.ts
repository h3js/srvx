import { connect as tlsConnect } from "node:tls";
import { describe, beforeAll, afterAll, expect, test } from "vitest";
import { fetch, Agent } from "undici";
import { addTests } from "./_tests.ts";
import { serve, FastResponse } from "../src/adapters/node.ts";
import { getTLSCert } from "./_utils.ts";
import { fixture } from "./_fixture.ts";

const tls = await getTLSCert();

const isDeno = !!globalThis.Deno;
const isBun = !!globalThis.Bun;
const runtime = isDeno ? `deno-node-compat` : isBun ? `bun-node-compat` : "node";

const testConfigs = [
  {
    name: "http1",
    Response: globalThis.Response,
    fastResponse: false,
  },
  {
    name: "http1, FastResponse",
    Response: FastResponse,
    fastResponse: true,
  },
  {
    name: "http2",
    Response: globalThis.Response,
    http2: true,
    serveOptions: { tls, node: { http2: true, allowHTTP1: false } },
    fastResponse: false,
  },
  {
    name: "http2, FastResponse",
    Response: FastResponse,
    http2: true,
    serveOptions: { tls, node: { http2: true, allowHTTP1: false } },
    fastResponse: true,
  },
];

for (const config of testConfigs) {
  if ((isDeno || isBun) && config.http2) {
    continue; // Not implemented yet in Deno, Bun fails somehow too! (https://github.com/h3js/srvx/issues/237)
  }
  describe.sequential(`${runtime} (${config.name})`, () => {
    const client = getHttpClient(config.http2);
    let server: ReturnType<typeof serve> | undefined;

    beforeAll(async () => {
      server = serve(
        fixture(
          {
            port: 0,
            ...config.serveOptions,
          },
          config.Response as unknown as typeof Response, // TODO: fix type incompatibility
        ),
      );
      await server!.ready();
    });

    afterAll(async () => {
      await client.agent?.close?.();
      await server!.close(true);
      await server!.close(true); // test idempotency
    });

    addTests({
      // For http2 (TLS), connect via the `localhost` hostname so the
      // certificate's DNS altname is used. Newer Node versions (>=26) no longer
      // match a bare IPv6 literal (`::1`) from `server.url` against the cert's
      // IP altnames, which breaks the IP-literal TLS check.
      url: (path) => {
        if (config.http2) {
          const u = new URL(server!.url!);
          u.hostname = "localhost";
          return u.href + path.slice(1);
        }
        return server!.url! + path.slice(1);
      },
      runtime,
      http2: config.http2,
      fetch: client.fetch,
      fastResponse: config.fastResponse,
      ca: tls.ca,
    });
  });
}

// An absolute-form request target (RFC 9112 §3.2.2) must never define the
// scheme: on a TLS listener a `http://...` target used to downgrade
// `request.url` to `http:`, defeating handler secure-request checks.
describe.skipIf(isDeno || isBun)(`${runtime} (absolute-form over TLS)`, () => {
  let server: ReturnType<typeof serve> | undefined;

  beforeAll(async () => {
    server = serve({
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      fetch: (request) => new Response(request.url),
    });
    await server!.ready();
  });

  afterAll(async () => {
    await server!.close(true);
  });

  function rawTLS(requestLine: string): Promise<string> {
    const address = server!.node!.server!.address() as { port: number };
    return new Promise((resolve, reject) => {
      const socket = tlsConnect(
        { port: address.port, host: "127.0.0.1", rejectUnauthorized: false },
        () => {
          socket.write(`${requestLine}\r\nHost: good.example\r\nConnection: close\r\n\r\n`);
        },
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error("socket timed out"));
      });
    });
  }

  test("origin-form keeps https:", async () => {
    expect(await rawTLS("GET /foo HTTP/1.1")).toContain("https://good.example/foo");
  });

  test("an http: absolute-form target cannot downgrade request.url", async () => {
    const response = await rawTLS("GET http://evil.example.com/x HTTP/1.1");
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
    expect(response).toContain("https://evil.example.com/x");
    expect(response).not.toContain("http://evil.example.com/x");
  });
});

function getHttpClient(h2?: boolean) {
  if (!h2) {
    return {
      fetch: globalThis.fetch,
      agent: undefined,
    };
  }
  const h2Agent = new Agent({ allowH2: true, connect: { ...tls } });
  const fetchWithHttp2 = ((input: any, init?: any) =>
    fetch(input, {
      ...init,
      dispatcher: h2Agent,
    })) as unknown as typeof globalThis.fetch;

  return { fetch: fetchWithHttp2, agent: h2Agent };
}
