import { afterEach, describe, expect, test, vi } from "vitest";

// Frameworks (e.g. Nitro) install `FastResponse` as `globalThis.Response` on Node.
describe("FastResponse as global Response", () => {
  const Native = globalThis.Response;
  const kNativeResponse = Symbol.for("srvx.nativeResponse");

  afterEach(() => {
    globalThis.Response = Native;
    delete (globalThis as any)[kNativeResponse];
    vi.resetModules();
  });

  async function loadFastResponse({ clearCache = false } = {}) {
    if (clearCache) {
      delete (globalThis as any)[kNativeResponse];
    }
    vi.resetModules();
    const { NodeResponse } = await import("../src/adapters/_node/response.ts");
    return NodeResponse;
  }

  test("instanceof stays scoped for subclasses", async () => {
    const FastResponse = await loadFastResponse();
    globalThis.Response = FastResponse as unknown as typeof Response;

    class MyRes extends Response {}

    expect(new Native("x") instanceof FastResponse).toBe(true);
    expect(new FastResponse("x") instanceof FastResponse).toBe(true);
    expect(new Native("x") instanceof Response).toBe(true);

    expect(new Native("x") instanceof MyRes).toBe(false);
    expect(new FastResponse("x") instanceof MyRes).toBe(false);
    expect(new MyRes("x") instanceof MyRes).toBe(true);
    expect(new MyRes("x") instanceof FastResponse).toBe(true);
  });

  test("re-evaluation wraps the native Response, not a previous FastResponse", async () => {
    const F1 = await loadFastResponse();
    globalThis.Response = F1 as unknown as typeof Response;

    const F2 = await loadFastResponse();
    expect(F2).not.toBe(F1);
    globalThis.Response = F2 as unknown as typeof Response;

    const F3 = await loadFastResponse();
    expect(Object.getPrototypeOf(F3)).toBe(Native);
    expect(Object.getPrototypeOf((new F3("x") as any)._response)).toBe(Native.prototype);
    expect(await new F3("hello").text()).toBe("hello");
  });

  test("unwraps a srvx global even without the native cache", async () => {
    const F1 = await loadFastResponse();
    class MyRes extends (F1 as unknown as typeof Response) {}
    globalThis.Response = MyRes;

    const F2 = await loadFastResponse({ clearCache: true });
    expect(Object.getPrototypeOf(F2)).toBe(Native);
    expect(Object.getPrototypeOf((new F2("x") as any)._response)).toBe(Native.prototype);
  });
});
