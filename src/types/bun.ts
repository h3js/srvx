// Minimal Bun types. See `src/types/README.md` for why these are inlined.

/**
 * Headers accepted by the runtime `Headers` constructor (`HeadersInit`).
 *
 * Derived from the ambient `Headers` so that it does not require `lib: ["dom"]`.
 */
type ResponseHeaders = NonNullable<ConstructorParameters<typeof globalThis.Headers>[0]>;

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
  readonly pendingWebSockets?: number;
  requestIP(request: Request): { address: string; family: "IPv4" | "IPv6"; port: number } | null;
  timeout(request: Request, seconds: number): void;
  /** Upgrade an incoming request to a WebSocket connection. */
  upgrade(request: Request, options?: { headers?: ResponseHeaders; data?: any }): boolean;
  /** Publish a message to every client subscribed to `topic`. */
  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
    compress?: boolean,
  ): number;
  subscriberCount(topic: string): number;
  reload(options: any): void;
  stop(closeActiveConnections?: boolean): Promise<void>;
  ref(): void;
  unref(): void;
}
