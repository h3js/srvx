import { describe, test, expectTypeOf } from "vitest";
import type { PeerCertificate } from "node:tls";
import type { ServerRequest } from "../src/types.ts";
import type { MTLSOptions } from "../src/mtls.ts";

describe("types", () => {
  describe("ServerRequest", () => {
    const request = new Request("http://_") as ServerRequest;
    describe("cloudflare", () => {
      test("env", () => {
        expectTypeOf(request.runtime?.cloudflare?.env).toEqualTypeOf<
          undefined | { TEST: string }
        >();
      });
    });
    // `request.tls` is contributed by the `srvx/mtls` mtls() module augmentation.
    describe("tls", () => {
      test("peerCertificate", () => {
        expectTypeOf(request.tls?.peerCertificate).toEqualTypeOf<undefined | PeerCertificate>();
      });
      test("authorized", () => {
        expectTypeOf(request.tls?.authorized).toEqualTypeOf<undefined | boolean>();
      });
    });
  });

  describe("MTLSOptions", () => {
    test("requestCert / ca", () => {
      expectTypeOf<MTLSOptions>().toExtend<{ requestCert?: boolean; ca?: string | string[] }>();
    });
  });
});
