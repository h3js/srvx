import { describe, test, expect, vi } from "vitest";
import { resolvePortAndHost, createWaitUntil } from "../src/_utils.ts";
import type { ServerOptions } from "../src/types.ts";

const withPort = (port: string | number): ServerOptions => ({
  port,
  fetch: () => new Response(),
});

describe("resolvePortAndHost", () => {
  test("uses numeric port option", () => {
    expect(resolvePortAndHost(withPort(8080)).port).toBe(8080);
  });

  test("parses string port option", () => {
    expect(resolvePortAndHost(withPort("8080")).port).toBe(8080);
  });

  test.each(["abc", ""])("throws RangeError for non-numeric port %j", (port) => {
    expect(() => resolvePortAndHost(withPort(port))).toThrow(RangeError);
    expect(() => resolvePortAndHost(withPort(port))).toThrow(/between 0 and 65535/);
  });

  test.each([-1, 65_536])("throws RangeError for out-of-range port %i", (port) => {
    expect(() => resolvePortAndHost(withPort(port))).toThrow(RangeError);
  });
});

describe("createWaitUntil", () => {
  test("does not leak resolved promises", async () => {
    const w = createWaitUntil();

    for (let i = 0; i < 100; i++) {
      w.waitUntil(Promise.resolve(i));
    }
    expect(w._size).toBe(100);

    await w.wait();
    expect(w._size).toBe(0);
  });

  test("does not leak rejected promises", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = createWaitUntil();

    for (let i = 0; i < 50; i++) {
      w.waitUntil(Promise.reject(new Error(`boom ${i}`)));
    }
    expect(w._size).toBe(50);

    await w.wait();
    expect(w._size).toBe(0);

    errorSpy.mockRestore();
  });

  test("ignores non-thenable values", () => {
    const w = createWaitUntil();
    w.waitUntil(undefined as any);
    w.waitUntil(42 as any);
    expect(w._size).toBe(0);
  });
});
