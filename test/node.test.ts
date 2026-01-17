import { fetch, Agent } from "undici";
import { addTests } from "./_tests.ts";
import { serve, FastResponse } from "../src/adapters/node.ts";
import { getTLSCert } from "./_utils.ts";
import { fixture } from "./_fixture.ts";

const tls = await getTLSCert();

const isDeno = !!globalThis.Deno;
const isBun = !!globalThis.Bun;
const runtime = isDeno
  ? `deno-node-compat`
  : isBun
    ? `bun-node-compat`
    : "node";

// Vitest is currently broken in Bun -_-
const { describe, beforeAll, afterAll, expect, test } = globalThis.Bun
  ? ((await import("bun:test")) as unknown as typeof import("vitest"))
  : await import("vitest");
if (!describe.sequential) {
  describe.sequential = describe;
}

const testConfigs = [
  {
    name: "http1",
    Response: globalThis.Response,
  },
  {
    name: "http1, FastResponse",
    Response: FastResponse,
  },
  {
    name: "http2",
    Response: globalThis.Response,
    http2: true,
    serveOptions: { tls, node: { http2: true, allowHTTP1: false } },
  },
  {
    name: "http2, FastResponse",
    Response: FastResponse,
    http2: true,
    serveOptions: { tls, node: { http2: true, allowHTTP1: false } },
  },
];

for (const config of testConfigs) {
  if ((isDeno || isBun) && config.http2) {
    continue; // Not implemented yet in Deno, Bun fails somehow too!
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
    });

    addTests({
      url: (path) => server!.url! + path.slice(1),
      runtime,
      http2: config.http2,
      fetch: client.fetch,
    });
  });
}

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
