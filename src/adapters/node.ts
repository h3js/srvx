import { sendNodeResponse } from "../_node-compat/send.ts";
import { NodeRequest } from "../_node-compat/request.ts";
import {
  fmtURL,
  resolveTLSOptions,
  printListening,
  resolvePortAndHost,
} from "../_utils.node.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";

import type NodeHttp from "node:http";
import type NodeHttps from "node:https";
import type NodeHttp2 from "node:http2";
import type {
  FetchHandler,
  NodeHttpHandler,
  NodeServerRequest,
  NodeServerResponse,
  Server,
  ServerHandler,
  ServerOptions,
} from "../types.ts";

export { FastURL } from "../_url.ts";

export {
  NodeResponse as FastResponse,
  NodeRequest,
  NodeResponse,
  NodeRequestHeaders,
  NodeResponseHeaders,
} from "../_node-compat/index.ts";

export function serve(options: ServerOptions): Server {
  return new NodeServer(options);
}

export function toNodeHandler(fetchHandler: FetchHandler): NodeHttpHandler {
  return (nodeReq, nodeRes) => {
    const request = new NodeRequest({ req: nodeReq, res: nodeRes });
    const res = fetchHandler(request);
    return res instanceof Promise
      ? res.then((resolvedRes) => sendNodeResponse(nodeRes, resolvedRes))
      : sendNodeResponse(nodeRes, res);
  };
}

// https://nodejs.org/api/http.html
// https://nodejs.org/api/https.html
// https://nodejs.org/api/http2.html
class NodeServer implements Server {
  readonly runtime = "node";
  readonly options: ServerOptions;
  readonly node: Server["node"];
  readonly serveOptions: ServerOptions["node"];
  readonly fetch: ServerHandler;
  readonly #isSecure: boolean;

  #listeningPromise?: Promise<void>;

  constructor(options: ServerOptions) {
    this.options = options;

    for (const plugin of options.plugins || []) plugin(this);
    errorPlugin(this);

    const fetchHandler = (this.fetch = wrapFetch(this));

    const handler = (
      nodeReq: NodeServerRequest,
      nodeRes: NodeServerResponse,
    ) => {
      const request = new NodeRequest({ req: nodeReq, res: nodeRes });
      const res = fetchHandler(request);
      return res instanceof Promise
        ? res.then((resolvedRes) => sendNodeResponse(nodeRes, resolvedRes))
        : sendNodeResponse(nodeRes, res);
    };

    const tls = resolveTLSOptions(this.options);
    const { port, hostname: host } = resolvePortAndHost(this.options);
    this.serveOptions = {
      port,
      host,
      exclusive: !this.options.reusePort,
      ...(tls
        ? { cert: tls.cert, key: tls.key, passphrase: tls.passphrase }
        : {}),
      ...this.options.node,
    };

    // prettier-ignore
    let server: NodeHttp.Server | NodeHttps.Server | NodeHttp2.Http2SecureServer;

    // prettier-ignore
    this.#isSecure = !!(this.serveOptions as { cert?: string }).cert && this.options.protocol !== "http";
    const isHttp2 = this.options.node?.http2 ?? this.#isSecure;

    if (isHttp2) {
      if (this.#isSecure) {
        const { createSecureServer } = process.getBuiltinModule("node:http2");
        server = createSecureServer(
          { allowHTTP1: true, ...this.serveOptions },
          handler,
        );
      } else {
        throw new Error("node.http2 option requires tls certificate!");
      }
    } else if (this.#isSecure) {
      const { createServer } = process.getBuiltinModule("node:https");
      server = createServer(
        this.serveOptions as NodeHttps.ServerOptions,
        handler,
      );
    } else {
      const { createServer } = process.getBuiltinModule("node:http");
      server = createServer(
        this.serveOptions as NodeHttp.ServerOptions,
        handler,
      );
    }

    this.node = { server, handler };

    if (!options.manual) {
      this.serve();
    }
  }

  serve() {
    if (this.#listeningPromise) {
      return Promise.resolve(this.#listeningPromise).then(() => this);
    }
    this.#listeningPromise = new Promise<void>((resolve) => {
      this.node!.server!.listen(this.serveOptions, () => {
        printListening(this.options, this.url);
        resolve();
      });
    });
  }

  get url() {
    const addr = this.node?.server?.address();
    if (!addr) {
      return;
    }

    return typeof addr === "string"
      ? addr /* socket */
      : fmtURL(addr.address, addr.port, this.#isSecure);
  }

  ready(): Promise<Server> {
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  close(closeAll?: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = this.node?.server;
      if (!server) {
        return resolve();
      }
      if (closeAll && "closeAllConnections" in server) {
        server.closeAllConnections();
      }
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  }
}
