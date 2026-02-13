import process from "node:process";

import type { BunnyFetchHandler, Server, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

type MaybePromise<T> = T | Promise<T>;

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

/**
 * Bunny global namespace types (from @bunny.net/edgescript-sdk)
 * @internal
 */
declare namespace Bunny {
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

  export const v1: BunnySDKV1;
}

export function serve(options: ServerOptions): Server<BunnyFetchHandler> {
  return new BunnyServer(options);
}

class BunnyServer implements Server<BunnyFetchHandler> {
  readonly runtime = "bunny";
  readonly options: Server["options"];
  readonly fetch: BunnyFetchHandler;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);
    errorPlugin(this);

    const fetchHandler = wrapFetch(this);

    this.fetch = (request: Request) => {
      Object.defineProperties(request, {
        runtime: {
          enumerable: true,
          value: { name: "bunny", bunny: {} },
        },
        // IP address from Bunny headers
        ip: {
          enumerable: true,
          get() {
            // Bunny uses X-Forwarded-For or similar headers
            return (
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
              request.headers.get("x-real-ip") ||
              undefined
            );
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
      Bunny.v1.serve(this.fetch);
    } else if (typeof Deno !== "undefined") {
      // Try to fallback to Deno's serve for local use
      if (!this.options.silent) {
        console.warn("[srvx] Bunny runtime not detected. Falling back to Deno for local use.");
      }
      const _parsedPort =
        typeof this.options.port === "number"
          ? this.options.port
          : Number.parseInt(this.options.port ?? process.env.NITRO_PORT ?? process.env.PORT ?? "");
      const port = !Number.isNaN(_parsedPort) ? _parsedPort : 3000;
      const hostname = this.options.hostname || process.env.NITRO_HOST || process.env.HOST;

      Deno.serve(
        {
          port,
          hostname,
        },
        this.fetch,
      );
    } else {
      throw new Error(
        "[srvx] Bunny runtime not detected and Deno is not available. Unable to start server.",
      );
    }
  }

  ready(): Promise<Server<BunnyFetchHandler>> {
    return Promise.resolve(this);
  }

  close() {
    // Bunny runtime doesn't support closing the server
    return Promise.resolve();
  }
}
