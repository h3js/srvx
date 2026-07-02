import { describe } from "vitest";
import { maxRequestBodySizeTests } from "./_max-body-size.ts";

describe("bun maxRequestBodySize", () => {
  maxRequestBodySizeTests("bun run ./fixtures/max-body-server.ts");
});
