import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import type * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";
import type { TrustProxyOption } from "./_trust-proxy.ts";
import type { BunHttpServer, BunServeOptions } from "./types/bun.ts";
import type { DenoHttpServer, DenoServeHandlerInfo, DenoServeOptions } from "./types/deno.ts";
import type { CloudflareEnv, CloudflareExecutionContext } from "./types/cloudflare.ts";
import type {
  AWSLambdaContext,
  AWSLambdaProxyEvent,
  AWSLambdaProxyEventV2,
} from "./types/aws-lambda.ts";
import type { ServiceWorkerFetchEvent } from "./types/service-worker.ts";

export type { TrustProxyOption } from "./_trust-proxy.ts";

// Utils
type MaybePromise<T> = T | Promise<T>;

// ----------------------------------------------------------------------------
// srvx API
// ----------------------------------------------------------------------------

/**
 * Faster URL constructor with lazy access to pathname and search params (For Node, Deno, and Bun).
 */
export declare const FastURL: typeof globalThis.URL;

/**
 * Faster Response constructor optimized for Node.js (same as Response for other runtimes).
 */
export declare const FastResponse: typeof globalThis.Response;

/**
 * Create a new server instance.
 */
export declare function serve(options: ServerOptions): Server;

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
   * Run multiple server processes sharing the same port (cluster mode).
   *
   * The main process becomes a small supervisor that spawns workers (re-executing the same entry),
   * restarts them when they crash and forwards shutdown signals. Set to a positive integer for the
   * worker count, or `true` to read it from the `SRVX_WORKERS` environment variable (number of
   * CPU cores when unset). `SRVX_WORKERS` alone also enables cluster mode; `false` (or `0`)
   * disables it entirely.
   *
   * Worker processes can be detected via the `SRVX_CLUSTER_WORKER` environment variable (worker index, starting at `"0"`).
   *
   * Supported on Node.js (`node:cluster`, all platforms) and on Bun and Deno (`SO_REUSEPORT`, load balancing on Linux only).
   * Serverless runtimes scale processes themselves and ignore this option.
   *
   * **Note:** Cluster mode requires a fixed port (`port: 0` is not supported).
   *
   * @see https://srvx.h3.dev/guide/cluster
   */
  cluster?: boolean | number;

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
   */
  node?: (NodeHttp.ServerOptions | NodeHttps.ServerOptions | NodeHttp2.ServerOptions) &
    NodeNet.ListenOptions & { http2?: boolean };

  /**
   * Bun server options
   *
   * @docs https://bun.sh/docs/api/http
   */
  bun?: BunServeOptions;

  /**
   * Deno server options
   *
   * @docs https://docs.deno.com/api/deno/~/Deno.serve
   */
  deno?: DenoServeOptions;

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
  readonly node?: {
    server?: NodeHttp.Server | NodeHttp2.Http2Server;
    handler: (req: NodeServerRequest, res: NodeServerResponse) => void | Promise<void>;
  };

  /**
   * Bun context.
   */
  readonly bun?: { server?: BunHttpServer };

  /**
   * Deno context.
   */
  readonly deno?: { server?: DenoHttpServer };

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
  node?: {
    req: NodeServerRequest;
    res?: NodeServerResponse;
  };

  /**
   * Underlying Deno server request info.
   */
  deno?: {
    info: DenoServeHandlerInfo;
  };

  /**
   * Underlying Bun server request context.
   */
  bun?: {
    server: BunHttpServer;
  };

  /**
   * Underlying Cloudflare request context.
   */
  cloudflare?: {
    context: CloudflareExecutionContext;
    env: CloudflareEnv;
  };

  awsLambda?: {
    context: AWSLambdaContext;
    event: AWSLambdaProxyEvent | AWSLambdaProxyEventV2;
  };

  serviceWorker?: { event: ServiceWorkerFetchEvent };

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

export type BunFetchHandler = (
  request: Request,
  server?: BunHttpServer,
) => Response | Promise<Response>;

export type DenoFetchHandler = (
  request: Request,
  info?: DenoServeHandlerInfo,
) => Response | Promise<Response>;

export type NodeServerRequest = NodeHttp.IncomingMessage | NodeHttp2.Http2ServerRequest;

export type NodeServerResponse = NodeHttp.ServerResponse | NodeHttp2.Http2ServerResponse;

export type NodeHttp1Handler = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => void | Promise<void>;

export type NodeHttp2Handler = (
  req: NodeHttp2.Http2ServerRequest,
  res: NodeHttp2.Http2ServerResponse,
) => void | Promise<void>;

export type NodeHttpHandler = NodeHttp1Handler | NodeHttp2Handler;

export type NodeHTTP1Middleware = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  next: (error?: Error) => void,
) => unknown | Promise<unknown>;

export type NodeHTTP2Middleware = (
  req: NodeHttp2.Http2ServerRequest,
  res: NodeHttp2.Http2ServerResponse,
  next: (error?: Error) => void,
) => unknown | Promise<unknown>;

export type NodeHTTPMiddleware = NodeHTTP1Middleware | NodeHTTP2Middleware;

export type CloudflareFetchHandler = (
  request: Request,
  env: CloudflareEnv,
  context: CloudflareExecutionContext,
) => Response | Promise<Response>;

// ----------------------------------------------------------------------------
// Runtime types
// ----------------------------------------------------------------------------

/**
 * Body accepted by the runtime `Response` constructor (`BodyInit`).
 *
 * Derived from the ambient `Response` so that it does not require `lib: ["dom"]`.
 */
export type ResponseBody = NonNullable<ConstructorParameters<typeof globalThis.Response>[0]>;

// Minimal declarations of the objects each runtime hands to srvx, so that the
// published types depend on no runtime type package (see `src/types/README.md`).
export type { BunHttpServer, BunServeOptions } from "./types/bun.ts";
export type { DenoHttpServer, DenoServeHandlerInfo, DenoServeOptions } from "./types/deno.ts";
export type { CloudflareEnv, CloudflareExecutionContext } from "./types/cloudflare.ts";
export type {
  AWSLambdaContext,
  AWSLambdaProxyEvent,
  AWSLambdaProxyEventV2,
  AWSLambdaProxyResult,
  AWSLambdaProxyResultV2,
} from "./types/aws-lambda.ts";
export type { ServiceWorkerFetchEvent } from "./types/service-worker.ts";
