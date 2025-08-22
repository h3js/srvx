import { describe, beforeAll, afterAll } from "vitest";
import { fetch, Agent } from "undici";
import type { RequestInfo, RequestInit } from "undici";
import { addTests } from "./_tests.ts";
import { serve, FastResponse } from "../src/adapters/uws.ts";
import { getTLSCert } from "./_utils.ts";
import { fixture } from "./_fixture.ts";

const tls = await getTLSCert();

const testConfigs = [
  {
    name: "http",
    Response: globalThis.Response,
  },
  {
    name: "http, FastResponse",
    Response: FastResponse,
  },
  {
    name: "https",
    Response: globalThis.Response,
    serveOptions: { tls },
  },
  {
    name: "https, FastResponse",
    Response: FastResponse,
    serveOptions: { tls },
  },
];

for (const config of testConfigs) {
  describe.sequential(`uws (${config.name})`, () => {
    const client = getHttpClient(config.serveOptions?.tls);
    let server: ReturnType<typeof serve> | undefined;

    beforeAll(async () => {
      server = serve(
        fixture(
          {
            port: 0,
            ...config.serveOptions,
          },
          config.Response as unknown as typeof Response,
        ),
      );
      await server!.ready();
    });

    afterAll(async () => {
      await client.agent?.close();
      await server!.close();
    });

    addTests({
      url: (path) => server!.url! + path.slice(1),
      runtime: "uws",
      fetch: client.fetch,
    });
  });
}

function getHttpClient(tlsOptions?: { key: string; cert: string }) {
  if (!tlsOptions) {
    return {
      fetch: globalThis.fetch,
      agent: undefined,
    };
  }
  const httpsAgent = new Agent({ connect: { ...tls } });
  const fetchWithHttps = (
    input: RequestInfo,
    init?: RequestInit,
  ): Promise<globalThis.Response> =>
    fetch(input, {
      ...init,
      dispatcher: httpsAgent,
    }) as unknown as Promise<globalThis.Response>;

  return {
    fetch: fetchWithHttps as unknown as typeof globalThis.fetch,
    agent: httpsAgent,
  };
}
