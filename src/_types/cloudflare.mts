import type * as CF from "@cloudflare/workers-types";

type IsAny<T> = Equal<T, any> extends true ? true : false;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

declare module "./core.mjs" {
  interface RuntimeTypes {
    "cloudflare.context": {
      context: CF.ExecutionContext;
      env: IsAny<typeof import("cloudflare:workers")> extends true
        ? Record<string, unknown>
        : typeof import("cloudflare:workers").env;
    };
  }
}

export type CloudflareFetchHandler = CF.ExportedHandlerFetchHandler;
