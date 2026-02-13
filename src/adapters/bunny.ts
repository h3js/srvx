import { resolvePortAndHost, createWaitUntil } from "../_utils.ts";
import type { Server, ServerOptions } from "../types.ts";
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

export function serve(options: ServerOptions): Server {
  return new BunnyServer(options);
}

class BunnyServer implements Server {
  readonly runtime = "bunny";
  readonly options: Server["options"];
  readonly fetch: (request: Request) => MaybePromise<Response>;
  private _denoServer?: Deno.HttpServer = undefined;
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
        runtime: {
          enumerable: true,
          value: { name: "bunny" },
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
    // Prevent multiple calls to serve, mostly for Bunny
    if (this._started) return;
    this._started = true;

    // Check if running in Bunny runtime
    if (typeof Bunny !== "undefined" && Bunny.v1?.serve) {
      Bunny.v1.serve(this.fetch);
    } else if (typeof Deno !== "undefined") {
      // Try to fallback to Deno's serve for local use
      if (!this.options.silent) {
        console.warn("[srvx] Bunny runtime not detected. Falling back to Deno for local use.");
      }
      const { port, hostname } = resolvePortAndHost(this.options);

      this._denoServer = Deno.serve(
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

  ready(): Promise<Server> {
    return Promise.resolve(this);
  }

  async close(): Promise<void> {
    // Bunny runtime doesn't support closing the server
    const promises = [this.#wait?.wait()];
    if (this._denoServer) {
      promises.push(this._denoServer.shutdown());
    }
    await Promise.all(promises);
  }
}
