import { describe } from "vitest";
import { testsExec } from "./_utils.ts";
import { addExecUnhandledThrowTests } from "./_error-tests.ts";

describe("bun", () => {
  testsExec("bun run ./_fixture.ts", { runtime: "bun" });
});

describe("bun (unhandled errors)", () => {
  addExecUnhandledThrowTests("bun run ./_error-fixture.ts");
});
