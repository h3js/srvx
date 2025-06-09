import { describe, test, expectTypeOf } from "vitest";
import type { ServerRequest } from "../src/types.ts";

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
  });
});
