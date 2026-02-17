import { resolvePortAndHost, resolveTLSOptions, createWaitUntil } from "../_utils.ts";
import type { Server, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

type MaybePromise<T> = T | Promise<T>;

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

/**
 * Bunny global namespace types
 *
 * Source: https://github.com/BunnyWay/edge-script-sdk/blob/main/libs/bunny-sdk/types/bunny.d.ts
 *
 * @internal
 */
declare namespace Bunny {
  export const v1: BunnySDKV1;

  type BunnySDKV1 = {
    /**
     * Serve function for Bunny Edge runtime
     */
    serve: (handler: (request: Request) => MaybePromise<Response>) => void;
    /**
     * Serve PullZone function, to leverage middlewares
     */
    registerMiddlewares: (middlewares: {
      onOriginRequest: Array<
        (ctx: { request: Request }) => Promise<Request> | Promise<Response> | undefined
      >;
      onOriginResponse: Array<
        (ctx: {
          request: Request;
          response: Response;
        }) => Promise<Request> | Promise<Response> | undefined
      >;
    }) => void;
  };
}

export function serve(options: ServerOptions): Server {
  return new BunnyServer(options);
}

class BunnyServer implements Server {
  readonly runtime = "bunny";
  readonly options: Server["options"];
  readonly fetch: (request: Request) => MaybePromise<Response>;
  private _started = false;

  #wait: ReturnType<typeof createWaitUntil> | undefined;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);
    errorPlugin(this);

    const fetchHandler = wrapFetch(this);

    this.#wait = createWaitUntil();

    this.fetch = (request: Request) => {
      Object.defineProperties(request, {
        waitUntil: { value: this.#wait?.waitUntil },
        runtime: { enumerable: true, value: { name: "bunny" } },
        ip: {
          enumerable: true,
          get() {
            return request.headers.get("x-real-ip");
          },
        },
      });
      return fetchHandler(request);
    };

    if (!options.manual) {
      this.serve();
    }
  }

  serve() {
    // Check if running in Bunny runtime
    if (typeof Bunny !== "undefined" && Bunny.v1?.serve) {
      // Prevent multiple calls to serve, mostly for Bunny
      if (this._started) return;
      this._started = true;

      Bunny.v1.serve(this.fetch);
    } else {
      throw new Error("[srvx] Bunny runtime not detected.");
    }
  }

  ready(): Promise<Server> {
    return Promise.resolve(this);
  }

  async close(): Promise<void> {
    await this.#wait?.wait();
  }
}
