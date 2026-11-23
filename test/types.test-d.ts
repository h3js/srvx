import { describe, test, expectTypeOf } from "vitest";
import type { PeerCertificate } from "node:tls";
import type { NodeHTTPMiddleware, ServerRequest } from "../src/types.ts";
import type { MTLSPluginOptions } from "../src/mtls.ts";
import { fetchNodeHandler, toFetchHandler } from "../src/adapters/node.ts";

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

  // Connect-style `(req, res, next)` middleware is invoked with a bridged `next`.
  describe("node handler", () => {
    const middleware = {} as NodeHTTPMiddleware;
    test("fetchNodeHandler accepts middleware", () => {
      expectTypeOf(fetchNodeHandler).toBeCallableWith(middleware, new Request("http://_"));
    });
    test("toFetchHandler accepts middleware", () => {
      expectTypeOf(toFetchHandler).toBeCallableWith(middleware);
    });
  });
});
