import type { TrustProxyOption } from "../_trust-proxy.ts";

export type { TrustProxyOption } from "../_trust-proxy.ts";

// Utils
type MaybePromise<T> = T | Promise<T>;

/**
 * Body accepted by the ambient `Response` constructor.
 *
 * Derived from the runtime's own `Response` because the global `BodyInit` is only
 * declared by the DOM lib, which server projects don't enable.
 */
export type ResponseBodyInit = NonNullable<ConstructorParameters<typeof globalThis.Response>[0]>;

// ----------------------------------------------------------------------------
// Runtime types registry
// ----------------------------------------------------------------------------

/**
 * Registry of runtime specific types.
 *
 * Entries are declared by the `srvx/<runtime>` entries, so that only the types of
 * the runtimes you import reference their (optional) `@types/*` packages.
 *
 * @docs https://srvx.h3.dev/guide#typescript
 */
export interface RuntimeTypes {}

/**
 * Resolve a runtime specific type, falling back to a loose one when the declarations
 * of that runtime are not loaded.
 */
export type RuntimeType<
  Key extends string,
  Fallback = Record<string, unknown>,
> = Key extends keyof RuntimeTypes ? RuntimeTypes[Key] : Fallback;

// ----------------------------------------------------------------------------
// srvx API
// ----------------------------------------------------------------------------

/**
 * Web fetch compatible request handler
 */
export type ServerHandler = (request: ServerRequest) => MaybePromise<Response>;

export type ServerMiddleware = (
  request: ServerRequest,
  next: () => Response | Promise<Response>,
) => Response | Promise<Response>;

export type ServerPlugin = (server: Server) => void;

/**
 * Server options
 */
export interface ServerOptions {
  /**
   * The fetch handler handles incoming requests.
   */
  fetch: ServerHandler;

  /**
   * Handle lifecycle errors.
   *
   * @note This handler will set built-in Bun and Deno error handler.
   */
  error?: ErrorHandler;

  /**
   * Server middleware handlers to run before the main fetch handler.
   */
  middleware?: ServerMiddleware[];

  /**
   * Server plugins.
   */
  plugins?: ServerPlugin[];

  /**
   * If set to `true`, server will not start listening automatically.
   */
  manual?: boolean;

  /**
   * The port server should be listening to.
   *
   * Default is read from `PORT` environment variable or will be `3000`.
   *
   * **Tip:** You can set the port to `0` to use a random port.
   */
  port?: string | number;

  /**
   * The hostname (IP or resolvable host) server listener should bound to.
   *
   * Default is read from the `HOST` environment variable. When neither is
   * provided, the server will listen to all network interfaces by default.
   *
   * **Important:** If you are running a server that is not expected to be exposed to the network, use `hostname: "localhost"`.
   */
  hostname?: string;

  /**
   * Enabling this option allows multiple processes to bind to the same port, which is useful for load balancing.
   *
   * **Note:** Despite Node.js built-in behavior that has `exclusive` flag (opposite of `reusePort`) enabled by default, srvx uses non-exclusive mode for consistency.
   */
  reusePort?: boolean;

  /**
   * The protocol to use for the server.
   *
   * Possible values are `http` and `https`.
   *
   * If `protocol` is not set, Server will use `http` as the default protocol or `https` if both `tls.cert` and `tls.key` options are provided.
   */
  protocol?: "http" | "https";

  /**
   * If set to `true`, server will not print the listening address.
   */
  silent?: boolean;

  /**
   * Graceful shutdown on SIGINT and SIGTERM signals.
   *
   * Supported for Node.js, Deno and Bun runtimes.
   *
   * @default true (disabled in test and ci environments)
   */
  gracefulShutdown?: boolean | { gracefulTimeout?: number; forceTimeout?: number };

  /**
   * Maximum allowed size (in bytes) for the request body.
   *
   * As the body is read, its accumulated length is tracked and, once it exceeds
   * this limit, reading is aborted and rejects with a `413`-style error (the error
   * has `statusCode: 413`, `status: 413` and `code: "ERR_BODY_TOO_LARGE"`) so a
   * handler can map it to an HTTP 413 (Payload Too Large) response.
   *
   * The limit covers the buffered reads (`request.text()` / `request.json()`) as
   * well as the streamed body (`request.body`, and therefore `arrayBuffer()` /
   * `blob()` / `bytes()` / `formData()`).
   *
   * Runtime support:
   * - **Node**: enforced by srvx (body stream is size-limited).
   * - **Bun**: mapped to Bun's native `maxRequestBodySize` (413 before the handler).
   * - **Deno**: enforced by srvx (request body stream is size-limited).
   *
   * @default undefined (no limit)
   */
  maxRequestBodySize?: number;

  /**
   * Whether to trust `X-Forwarded-*` headers (`X-Forwarded-Proto`,
   * `X-Forwarded-Host`, `X-Forwarded-For`, and the HTTP/2 `:scheme`) when
   * deriving `request.url` and `request.ip`.
   *
   * Any client can send `X-Forwarded-Proto: https`, `X-Forwarded-Host` or
   * `X-Forwarded-For`, so trusting them lets a request masquerade as `https:`,
   * forge its host, or spoof its client IP. Only enable this when a proxy you
   * control sits in front and overwrites the headers.
   *
   * - `false` (default): ignore the headers; use the real connection protocol,
   *   the on-the-wire `Host` header and the socket peer address.
   * - `true`: always trust the headers.
   * - `"loopback"`: trust them only when the proxy connects from a loopback
   *   address (`127.0.0.0/8` or `::1`).
   * - `string[]`: trust them only when the proxy's address is in the list.
   *
   * Applies to the Node, AWS Lambda, Bun and Deno adapters.
   *
   * @default false
   */
  trustProxy?: TrustProxyOption;

  /**
   * TLS server options.
   */
  tls?: {
    /**
     * File path or inlined TLS certificate in PEM format (required).
     */
    cert?: string;

    /**
     * File path or inlined TLS private key in PEM format (required).
     */
    key?: string;

    /**
     * Passphrase for the private key (optional).
     */
    passphrase?: string;
  };

  /**
   * Node.js server options.
   *
   * Typed by `@types/node` when the types of `srvx` or `srvx/node` are loaded.
   */
  node?: RuntimeType<"node.options">;

  /**
   * Bun server options
   *
   * Typed by `@types/bun` when the types of `srvx` or `srvx/bun` are loaded.
   *
   * @docs https://bun.sh/docs/api/http
   */
  bun?: RuntimeType<"bun.options">;

  /**
   * Deno server options
   *
   * Typed by `@types/deno` when the types of `srvx` or `srvx/deno` are loaded.
   *
   * @docs https://docs.deno.com/api/deno/~/Deno.serve
   */
  deno?: RuntimeType<"deno.options">;

  /**
   * Service worker options
   */
  serviceWorker?: {
    /**
     * The path to the service worker file to be registered.
     */
    url?: string;

    /**
     * The scope of the service worker.
     *
     */
    scope?: string;
  };
}

export interface Server<Handler = ServerHandler> {
  /**
   * Current runtime name
   */
  readonly runtime:
    | "node"
    | "deno"
    | "bun"
    | "bunny"
    | "cloudflare"
    | "service-worker"
    | "aws-lambda"
    | "generic";

  /**
   * Server options
   */
  readonly options: ServerOptions & { middleware: ServerMiddleware[] };

  /**
   * Server URL address.
   */
  readonly url?: string;

  /**
   * Node.js context.
   */
  readonly node?: RuntimeType<"node.server">;

  /**
   * Bun context.
   */
  readonly bun?: RuntimeType<"bun.server">;

  /**
   * Deno context.
   */
  readonly deno?: RuntimeType<"deno.server">;

  /**
   * Server fetch handler
   */
  readonly fetch: Handler;

  /**
   * Start listening for incoming requests.
   * When `manual` option is enabled, this method needs to be called explicitly to begin accepting connections.
   */
  serve(): void | Promise<Server<Handler>>;

  /**
   * Returns a promise that resolves when the server is ready.
   */
  ready(): Promise<Server<Handler>>;

  /**
   * Register a background task that the server should await before closing.
   *
   * Same as `request.waitUntil` but available at the server level for use outside of request handlers.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;

  /**
   * Stop listening to prevent new connections from being accepted.
   *
   * By default, it does not cancel in-flight requests or websockets. That means it may take some time before all network activity stops.
   *
   * @param closeActiveConnections Immediately terminate in-flight requests, websockets, and stop accepting new connections.
   * @default false
   */
  close(closeActiveConnections?: boolean): Promise<void>;
}

// ----------------------------------------------------------------------------
// Request with runtime addons.
// ----------------------------------------------------------------------------

export interface ServerRuntimeContext {
  name: "node" | "deno" | "bun" | "bunny" | "cloudflare" | "aws-lambda" | (string & {});

  /**
   * Underlying Node.js server request info.
   */
  node?: RuntimeType<"node.context">;

  /**
   * Underlying Deno server request info.
   */
  deno?: RuntimeType<"deno.context">;

  /**
   * Underlying Bun server request context.
   */
  bun?: RuntimeType<"bun.context">;

  /**
   * Underlying Cloudflare request context.
   */
  cloudflare?: RuntimeType<"cloudflare.context">;

  awsLambda?: RuntimeType<"aws-lambda.context">;

  serviceWorker?: RuntimeType<"service-worker.context">;

  netlify?: { context: any };

  stormkit?: { event: any; context: any };

  vercel?: { context: { waitUntil?: (promise: Promise<any>) => void } };
}

export interface ServerRequestContext {
  [key: string]: unknown;
}

export interface ServerRequest extends Request {
  /**
   * The underlying web-standard `Request` backing this request.
   *
   * See https://srvx.h3.dev/guide/node#noderequest
   */
  _request?: Request;

  /**
   * Access to the parsed URL of this request.
   */
  _url?: URL;

  /**
   * Runtime specific request context.
   */
  runtime?: ServerRuntimeContext;

  /**
   * IP address of the client.
   */
  ip?: string | undefined;

  /**
   * Arbitrary context related to the request.
   */
  context?: ServerRequestContext;

  /**
   * Tell the runtime about an ongoing operation that shouldn't close until the promise resolves.
   */
  waitUntil?: (promise: Promise<unknown>) => void | Promise<void>;
}

// ----------------------------------------------------------------------------
// Different handler types
// ----------------------------------------------------------------------------

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export type ErrorHandler = (error: unknown) => Response | Promise<Response>;
