export function lazyInherit(target: any, source: any, sourceKey: any): void {
  for (const key of Object.getOwnPropertyNames(source)) {
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
