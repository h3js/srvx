import { describe } from "vitest";
import { maxRequestBodySizeTests } from "./_max-body-size.ts";

describe("deno maxRequestBodySize", () => {
  maxRequestBodySizeTests("deno run -A ./fixtures/max-body-server.ts");
});
