import { describe } from "vitest";
import { maxBodySizeTests } from "./_max-body-size.ts";

describe("deno maxBodySize", () => {
  maxBodySizeTests("deno run -A ./fixtures/max-body-server.ts");
});
