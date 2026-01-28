import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntry, type CLIOptions } from "../src/loader.ts";

function baseOpts(dir: string): CLIOptions {
  return {
    _dir: dir,
    _entry: "",
    _prod: false,
    _static: "public",
  };
}

describe("loadEntry", () => {
  it("returns 404 handler when no entry exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srvx-loader-"));

    const res = await loadEntry(baseOpts(dir));
    expect(res._error).toMatch(/No server entry file found/);

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(404);
    const html = await out.text();
    expect(html).toContain("No Server Entry");
  });

  it("loads module that exports fetch (named)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srvx-loader-"));
    const entry = join(dir, "server.mjs");
    writeFileSync(
      entry,
      `export function fetch() { return new Response('ok'); }`,
    );

    const res = await loadEntry(baseOpts(dir));
    expect(res._error).toBeUndefined();

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("ok");
  });

  it("loads module that exports default.fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srvx-loader-"));
    const entry = join(dir, "server.mjs");
    writeFileSync(
      entry,
      `export default { fetch() { return new Response('ok2'); } }`,
    );

    const res = await loadEntry(baseOpts(dir));
    expect(res._error).toBeUndefined();

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("ok2");
  });

  it("returns 500 handler when entry does not export fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srvx-loader-"));
    const entry = join(dir, "server.mjs");
    writeFileSync(entry, `export const x = 1;`);

    const res = await loadEntry(baseOpts(dir));
    expect(res._error).toMatch(/does not export a valid fetch handler/);

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(500);
    const html = await out.text();
    expect(html).toContain("Invalid Entry");
  });
});
