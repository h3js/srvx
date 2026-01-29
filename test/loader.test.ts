import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadServerEntry } from "../src/loader.ts";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("loadServerEntry", () => {
  describe("module exports", () => {
    it("loads module with direct fetch export", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "fetch-export"),
      });

      expect(result.notFound).toBeUndefined();
      expect(result.fetch).toBeDefined();
      expect(result.nodeCompat).toBe(false);
      expect(result.url).toContain("fetch-export/server.ts");

      const response = await result.fetch!(new Request("http://test/"));
      expect(await response.text()).toBe("fetch-export");
    });

    it("loads module with default.fetch export", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "default-fetch"),
      });

      expect(result.notFound).toBeUndefined();
      expect(result.fetch).toBeDefined();
      expect(result.nodeCompat).toBe(false);

      const response = await result.fetch!(new Request("http://test/"));
      expect(await response.text()).toBe("default-fetch");
    });

    it("loads Node.js style handler and upgrades it", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "node-handler"),
      });

      expect(result.notFound).toBeUndefined();
      expect(result.fetch).toBeDefined();
      expect(result.nodeCompat).toBe(true);
      expect(result.module.default).toBeTypeOf("function");
    });
  });

  describe("auto-discovery", () => {
    it("discovers index.ts when server.ts is not present", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "auto-discover"),
      });

      expect(result.notFound).toBeUndefined();
      expect(result.url).toContain("auto-discover/index.ts");

      const response = await result.fetch!(new Request("http://test/"));
      expect(await response.text()).toBe("auto-discover");
    });

    it("discovers src/server.ts", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "src-entry"),
      });

      expect(result.notFound).toBeUndefined();
      expect(result.url).toContain("src-entry/src/server.ts");

      const response = await result.fetch!(new Request("http://test/"));
      expect(await response.text()).toBe("src-entry");
    });
  });

  describe("explicit url option", () => {
    it("loads from explicit url path", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "explicit-url"),
        entry: "custom-entry.ts",
      });

      expect(result.notFound).toBeUndefined();
      expect(result.url).toContain("explicit-url/custom-entry.ts");

      const response = await result.fetch!(new Request("http://test/"));
      expect(await response.text()).toBe("explicit-url");
    });

    it("returns notFound when explicit url does not exist", async () => {
      const result = await loadServerEntry({
        dir: fixturesDir,
        entry: "non-existent.ts",
      });

      expect(result.notFound).toBe(true);
      expect(result.fetch).toBeUndefined();
    });
  });

  describe("notFound", () => {
    it("returns notFound when no entry is found", async () => {
      const result = await loadServerEntry({
        dir: resolve(fixturesDir, "empty-dir"),
      });

      expect(result.notFound).toBe(true);
      expect(result.fetch).toBeUndefined();
      expect(result.module).toBeUndefined();
    });
  });
});
