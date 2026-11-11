/**
 * Resolve the runtime's native class behind a (possibly patched) global and
 * cache it on `globalThis[key]`.
 *
 * The global may be replaced by a subclass: srvx's own (`patchGlobalRequest()`,
 * `FastResponse` installed as `Response`), another server's (Hono's
 * `@hono/node-server` overrides `Request`/`Response`) or a user's. Wrapping such
 * a subclass breaks `lazyInherit` (it only copies the subclass's own members, so
 * native accessors like `clone()` or `bytes()` hit undici with the wrong
 * receiver) and nests a layer per re-evaluation. Native `Request`, `Response`
 * and `Headers` are base classes in Node, Bun and Deno, so walking up to the
 * class whose parent is `Function.prototype` finds the native one regardless
 * of patch order. (Polyfills with their own base class, e.g. node-fetch's
 * `Body`, are not supported.)
 */
export function getNativeClass<T>(key: symbol, current: T): T {
  let C: any = (globalThis as any)[key] || current;
  let P = Object.getPrototypeOf(C);
  // Checks `.prototype` rather than `P !== Function.prototype`: globals copied
  // from another realm (vitest `vmThreads`, Jest's node environment) inherit
  // from that realm's `Function.prototype`, which has no `.prototype`.
  while (typeof P === "function" && P.prototype) {
    C = P;
    P = Object.getPrototypeOf(C);
  }
  return ((globalThis as any)[key] = C);
}

export function lazyInherit(target: any, source: any, sourceKey: any): void {
  for (const key of [
    ...Object.getOwnPropertyNames(source),
    ...Object.getOwnPropertySymbols(source),
  ]) {
    if (key === "constructor") continue;
    const targetDesc = Object.getOwnPropertyDescriptor(target, key)!;
    const desc = Object.getOwnPropertyDescriptor(source, key)!;
    let modified = false;
    if (desc.get) {
      modified = true;
      desc.get =
        targetDesc?.get ||
        function () {
          // @ts-expect-error
          return this[sourceKey][key];
        };
    }
    if (desc.set) {
      modified = true;
      desc.set =
        targetDesc?.set ||
        function (value) {
          // @ts-expect-error
          this[sourceKey][key] = value;
        };
    }
    if (!targetDesc?.value && typeof desc.value === "function") {
      modified = true;
      desc.value = function (...args: unknown[]) {
        // @ts-expect-error
        return this[sourceKey][key](...args);
      };
    }
    if (modified) {
      Object.defineProperty(target, key, desc);
    }
  }
}
