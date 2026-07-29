import type * as Bun from "bun";

declare module "./core.mjs" {
  interface RuntimeTypes {
    "bun.options": Omit<Bun.Serve.Options<any>, "fetch">;

    "bun.server": { server?: Bun.Server<any> };

    "bun.context": { server: Bun.Server<any> };
  }
}

export type BunFetchHandler = (
  request: Request,
  server?: Bun.Server<any>,
) => Response | Promise<Response>;
