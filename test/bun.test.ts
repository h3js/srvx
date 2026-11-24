import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { execa } from "execa";
import { testsExec } from "./_utils.ts";
import { addExecUnhandledThrowTests } from "./_error-tests.ts";

describe("bun", () => {
  testsExec("bun run ./_fixture.ts", { runtime: "bun" });
});

describe("bun (unhandled errors)", () => {
  addExecUnhandledThrowTests("bun run ./_error-fixture.ts");
});

describe("bun static", () => {
  test("a response cancelled by the client closes its file", async () => {
    const { exitCode, stdout, stderr } = await execa(
      "bun",
      ["run", "./fixtures/static-cancel.ts"],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        reject: false,
      },
    );
    expect(stderr).not.toMatch(/FileHandle/);
    expect(stdout.trim().split("\n").at(-1)).toBe("ok");
    expect(exitCode).toBe(0);
  });
});
