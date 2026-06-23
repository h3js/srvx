import { describe, test, expectTypeOf } from "vitest";
import type { PeerCertificate } from "node:tls";
import type { ServerOptions, ServerRequest } from "../src/types.ts";

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
    describe("tls", () => {
      test("peerCertificate", () => {
        expectTypeOf(request.tls?.peerCertificate).toEqualTypeOf<undefined | PeerCertificate>();
      });
      test("authorized", () => {
        expectTypeOf(request.tls?.authorized).toEqualTypeOf<undefined | boolean>();
      });
    });
  });

  describe("ServerOptions", () => {
    test("tls.requestCert / ca", () => {
      expectTypeOf<ServerOptions["tls"]>().toExtend<
        undefined | { requestCert?: boolean; ca?: string | string[] }
      >();
    });
  });
});
