import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import type * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";

declare module "./core.mjs" {
  interface RuntimeTypes {
    "node.options": (NodeHttp.ServerOptions | NodeHttps.ServerOptions | NodeHttp2.ServerOptions) &
      NodeNet.ListenOptions & { http2?: boolean };

    "node.server": {
      server?: NodeHttp.Server | NodeHttp2.Http2Server;
      handler: (req: NodeServerRequest, res: NodeServerResponse) => void | Promise<void>;
    };

    "node.context": {
      req: NodeServerRequest;
      res?: NodeServerResponse;
    };
  }
}

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
