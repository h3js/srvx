export const kNodeInspect: symbol = /* @__PURE__ */ Symbol.for(
  "nodejs.util.inspect.custom",
);

export function inheritProps(target: any, source: any, sourceKey: any): void {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key in target) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(source, key)!;
    if (desc.get) {
      Object.defineProperty(target, key, {
        ...desc,
        get() {
          return this[sourceKey][key];
        },
      });
    } else if (typeof desc.value === "function") {
      Object.defineProperty(target, key, {
        ...desc,
        value(...args: unknown[]) {
          return this[sourceKey][key](...args);
        },
      });
    } else {
      Object.defineProperty(target, key, desc);
    }
  }
}
