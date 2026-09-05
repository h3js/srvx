import { describe } from "vitest";
import { testsExec } from "./_utils.ts";
import { addExecUnhandledThrowTests } from "./_error-tests.ts";

describe("deno", () => {
  testsExec("deno run -A ./_fixture.ts", {
    runtime: "deno",
  });
});

describe("deno (unhandled errors)", () => {
  addExecUnhandledThrowTests("deno run -A ./_error-fixture.ts");
});
