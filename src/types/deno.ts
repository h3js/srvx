// Minimal Deno types. See `src/types/README.md` for why these are inlined.

/**
 * Options forwarded to `Deno.serve()`.
 *
 * @docs https://docs.deno.com/api/deno/~/Deno.serve
 */
export interface DenoServeOptions {
  port?: number;
  hostname?: string;
  reusePort?: boolean;
  signal?: AbortSignal;
  key?: string;
  cert?: string;
  passphrase?: string;
  onError?: (error: unknown) => Response | Promise<Response>;
  onListen?: (localAddr: { hostname: string; port: number }) => void;
  /** Any other option supported by the running Deno version. */
  [key: string]: any;
}

/**
 * Server instance returned by `Deno.serve()` (`Deno.HttpServer`).
 */
export interface DenoHttpServer {
  readonly finished: Promise<void>;
  readonly addr?: { hostname?: string; port?: number; transport?: string };
  shutdown(): Promise<void>;
  ref(): void;
  unref(): void;
}

/**
 * Second argument Deno passes to the fetch handler (`Deno.ServeHandlerInfo`).
 */
export interface DenoServeHandlerInfo {
  readonly remoteAddr: { hostname: string; port: number; transport?: string };
  readonly completed?: Promise<void>;
}
