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

describe("bun (static)", () => {
  // h3js/srvx#341: a static file response cancelled by the client must close its
  // `FileHandle`, or Bun exits when GC collects it.
  test("closes files of responses aborted by the client", { timeout: 30_000 }, async () => {
    const fixture = fileURLToPath(new URL("fixtures/static-abort.ts", import.meta.url));
    const result = await execa("bun", ["run", fixture], { reject: false });
    expect(result.stderr).not.toContain("FileHandle object was closed during garbage collection");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});
