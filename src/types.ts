import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import type * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";
import type * as Bun from "bun";
import type * as CF from "@cloudflare/workers-types";
import type * as AWS from "aws-lambda";

// Utils
type MaybePromise<T> = T | Promise<T>;
type IsAny<T> = Equal<T, any> extends true ? true : false;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

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
   * When not provided, server with listen to all network interfaces by default.
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
  bun?: Omit<Bun.Serve.Options<any>, "fetch">;

  /**
   * Deno server options
   *
   * @docs https://docs.deno.com/api/deno/~/Deno.serve
   */
  deno?: Deno.ServeOptions;

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
  readonly bun?: { server?: Bun.Server<any> };

  /**
   * Deno context.
   */
  readonly deno?: { server?: Deno.HttpServer };

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
  name: "node" | "deno" | "bun" | "cloudflare" | "aws-lambda" | (string & {});

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
    info: Deno.ServeHandlerInfo<Deno.NetAddr>;
  };

  /**
   * Underlying Bun server request context.
   */
  bun?: {
    server: Bun.Server<any>;
  };

  /**
   * Underlying Cloudflare request context.
   */
  cloudflare?: {
    context: CF.ExecutionContext;
    env: IsAny<typeof import("cloudflare:workers")> extends true
      ? Record<string, unknown>
      : typeof import("cloudflare:workers").env;
  };

  awsLambda?: {
    context: AWS.Context;
    event: AWS.APIGatewayProxyEvent | AWS.APIGatewayProxyEventV2;
  };

  serviceWorker?: { event: FetchEvent };

  netlify?: { context: any };

  stormkit?: { event: any; context: any };

  vercel?: { context: { waitUntil?: (promise: Promise<any>) => void } };
}

export interface ServerRequestContext {
  [key: string]: unknown;
}

export interface ServerRequest extends Request {
  /**
   * Access to Node.js native instance of request.
   *
   * See https://srvx.h3.dev/guide/node#noderequest
   */
  _request?: Request;

  /**
   * Access to the parsed URL
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
  server?: Bun.Server<any>,
) => Response | Promise<Response>;

export type DenoFetchHandler = (
  request: Request,
  info?: Deno.ServeHandlerInfo<Deno.NetAddr>,
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

export type CloudflareFetchHandler = CF.ExportedHandlerFetchHandler;
