import { describe } from "vitest";
import { maxBodySizeTests } from "./_max-body-size.ts";

describe("bun maxBodySize", () => {
  maxBodySizeTests("bun run ./fixtures/max-body-server.ts");
});
