// Minimal Bun types. See `src/types/README.md` for why these are inlined.

/**
 * Options forwarded to `Bun.serve()`.
 *
 * @docs https://bun.sh/docs/api/http
 */
export interface BunServeOptions {
  port?: string | number;
  hostname?: string;
  unix?: string;
  reusePort?: boolean;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  development?: boolean;
  error?: (error: any) => any;
  tls?: any;
  /** Any other option supported by the running Bun version. */
  [key: string]: any;
}

/**
 * Server instance returned by `Bun.serve()` (`Bun.Server`).
 */
export interface BunHttpServer {
  readonly url: URL;
  readonly port?: number;
  readonly hostname?: string;
  readonly development?: boolean;
  readonly pendingRequests?: number;
  requestIP(request: Request): { address: string; family: string; port: number } | null;
  stop(closeActiveConnections?: boolean): Promise<void>;
  ref(): void;
  unref(): void;
}
