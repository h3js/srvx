import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadEntry } from "../src/loader.ts";
import type { CLIOptions } from "../src/cli.ts";

const fixturesDir = fileURLToPath(new URL("fixtures/loaders", import.meta.url));

function baseOpts(name: string): CLIOptions {
  return {
    _dir: join(fixturesDir, name),
    _entry: "",
    _prod: false,
    _static: "public",
  };
}

const ctx = {
  defaultEntries: [
    "server",
    "index",
    "src/server",
    "src/index",
    "server/index",
  ],
  defaultExts: [".mts", ".ts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".tsx"],
  interceptListen: async (cb: any) => ({ res: await cb() }),
  renderError: (error: unknown, status = 500, title = "Server Error") => {
    const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body>${String(error)}</body></html>`;
    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
} as const;

describe("loadEntry", () => {
  it("returns 404 handler when no entry exists", async () => {
    const res = await loadEntry(baseOpts("empty"), ctx);
    expect(res._error).toMatch(/No server entry file found/);

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(404);
    const html = await out.text();
    expect(html).toContain("No Server Entry");
  });

  it("loads module that exports fetch (named)", async () => {
    const res = await loadEntry(baseOpts("named-fetch"), ctx);
    expect(res._error).toBeUndefined();

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("ok");
  });

  it("loads module that exports default.fetch", async () => {
    const res = await loadEntry(baseOpts("default-fetch"), ctx);
    expect(res._error).toBeUndefined();

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("ok2");
  });

  it("returns 500 handler when entry does not export fetch", async () => {
    const res = await loadEntry(baseOpts("invalid-entry"), ctx);
    expect(res._error).toMatch(/does not export a valid fetch handler/);

    const out = await res.fetch!(new Request("http://localhost/"));
    expect(out.status).toBe(500);
    const html = await out.text();
    expect(html).toContain("Invalid Entry");
  });
});
