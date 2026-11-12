import { describe, test, expectTypeOf } from "vitest";
import type { PeerCertificate } from "node:tls";
import type { ServerRequest } from "../src/types.ts";
import type { MTLSPluginOptions } from "../src/mtls.ts";
import type { RequestListener } from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import type { toNodeHandler } from "../src/adapters/node.ts";

// `CloudflareEnv` is the augmentation point for Workers bindings.
declare module "../src/types.ts" {
  interface CloudflareEnv {
    TEST?: string;
  }
}

describe("types", () => {
  describe("ServerRequest", () => {
    const request = new Request("http://_") as ServerRequest;
    describe("cloudflare", () => {
      test("env", () => {
        expectTypeOf(request.runtime?.cloudflare?.env.TEST).toEqualTypeOf<undefined | string>();
      });
    });
    // `request.tls` is contributed by the `srvx/mtls` mtlsPlugin() module augmentation.
    describe("tls", () => {
      test("peerCertificate", () => {
        expectTypeOf(request.tls?.peerCertificate).toEqualTypeOf<undefined | PeerCertificate>();
      });
      test("authorized", () => {
        expectTypeOf(request.tls?.authorized).toEqualTypeOf<undefined | boolean>();
      });
    });
  });

  describe("MTLSPluginOptions", () => {
    test("requestCert / ca", () => {
      expectTypeOf<MTLSPluginOptions>().toExtend<{
        requestCert?: boolean;
        ca?: string | string[];
      }>();
    });
  });

  describe("toNodeHandler", () => {
    type NodeHandler = ReturnType<typeof toNodeHandler>;
    test("is assignable to a node:http request listener", () => {
      expectTypeOf<NodeHandler>().toExtend<RequestListener>();
    });
    test("is assignable to a node:http2 request listener", () => {
      expectTypeOf<NodeHandler>().toExtend<
        (request: Http2ServerRequest, response: Http2ServerResponse) => void
      >();
    });
  });
});
