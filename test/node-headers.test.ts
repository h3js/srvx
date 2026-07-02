/**
 * Tests for NodeRequestHeaders duplicate header handling.
 *
 * In HTTP/2, cookies arrive as separate rawHeaders entries.
 * The headers iterator must combine them (via append) so that
 * Object.fromEntries(headers.entries()) doesn't lose values.
 *
 * Ref: https://github.com/h3js/srvx/issues/188
 */
import { describe, expect, test } from "vitest";
import { NodeRequestHeaders } from "../src/adapters/_node/headers.ts";

function mockReq(rawHeaders: string[], headers: Record<string, string | string[]>) {
  return { rawHeaders, headers } as any;
}

describe("NodeRequestHeaders", () => {
  test("entries() combines duplicate headers (#188)", () => {
    // Simulate HTTP/2 splitting cookies into separate rawHeaders entries
    const req = mockReq(["cookie", "a=1", "cookie", "b=2", "host", "localhost"], {
      cookie: ["a=1", "b=2"],
      host: "localhost",
    });
    const headers = new NodeRequestHeaders(req);

    const entries = Object.fromEntries(headers.entries());
    // Should contain both cookies combined, not just the last one
    expect(entries.cookie).toContain("a=1");
    expect(entries.cookie).toContain("b=2");
    expect(entries.host).toBe("localhost");
  });

  test("[Symbol.iterator] combines duplicate headers (#188)", () => {
    const req = mockReq(["cookie", "first=1", "cookie", "second=2"], {
      cookie: ["first=1", "second=2"],
    });
    const headers = new NodeRequestHeaders(req);

    const entries = Object.fromEntries(headers);
    expect(entries.cookie).toContain("first=1");
    expect(entries.cookie).toContain("second=2");
  });

  test("get() combines duplicate headers", () => {
    const req = mockReq(["cookie", "a=1", "cookie", "b=2"], { cookie: ["a=1", "b=2"] });
    const headers = new NodeRequestHeaders(req);

    const cookie = headers.get("cookie");
    expect(cookie).toContain("a=1");
    expect(cookie).toContain("b=2");
  });

  test("get()/has() combine duplicate single-value headers regardless of iteration order", () => {
    // Node collapses headers it treats as single-value (authorization,
    // content-type, …) to the FIRST occurrence in `req.headers`, while
    // `rawHeaders` keeps every occurrence. The result must not depend on
    // whether the Headers object was iterated first.
    const rawHeaders = [
      "authorization",
      "Bearer AAA",
      "authorization",
      "Bearer BBB",
      "content-type",
      "text/plain",
      "content-type",
      "application/json",
    ];
    const collapsed = { authorization: "Bearer AAA", "content-type": "text/plain" };

    // Fresh instance: get() before any iteration.
    const before = new NodeRequestHeaders(mockReq(rawHeaders, collapsed));
    expect(before.get("authorization")).toBe("Bearer AAA, Bearer BBB");
    expect(before.get("content-type")).toBe("text/plain, application/json");
    expect(before.has("authorization")).toBe(true);

    // Separate instance, iterated first, then get(): must match.
    const after = new NodeRequestHeaders(mockReq(rawHeaders, collapsed));
    void [...after.entries()];
    expect(after.get("authorization")).toBe("Bearer AAA, Bearer BBB");
    expect(after.get("content-type")).toBe("text/plain, application/json");
  });
});
