declare module "./core.mjs" {
  interface RuntimeTypes {
    "deno.options": Deno.ServeOptions;

    "deno.server": { server?: Deno.HttpServer };

    "deno.context": { info: Deno.ServeHandlerInfo<Deno.NetAddr> };
  }
}

export type DenoFetchHandler = (
  request: Request,
  info?: Deno.ServeHandlerInfo<Deno.NetAddr>,
) => Response | Promise<Response>;
