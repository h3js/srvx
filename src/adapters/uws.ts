import type {
  FetchHandler,
  Server,
  ServerOptions,
  ServerHandler,
  UWSHTTPHandler,
} from "../types.ts";
import {
  createWaitUntil,
  fmtURL,
  printListening,
  resolvePortAndHost,
} from "../_utils.ts";
import { wrapFetch } from "../_middleware.ts";
import { UWSRequest } from "./_uws/request.ts";
import { sendUWSResponse } from "./_uws/send.ts";
import { errorPlugin } from "../_plugins.ts";

import type { us_listen_socket } from "uWebSockets.js";

export { FastURL } from "../_url.ts";
export { UWSRequest } from "./_uws/request.ts";
export { UWSRequestHeaders, UWSResponseHeaders } from "./_uws/headers.ts";
export { UWSResponse, UWSResponse as FastResponse } from "./_uws/response.ts";
export { sendUWSResponse } from "./_uws/send.ts";

export function serve(options: ServerOptions): Server {
  return new UWSServer(options);
}

export function toUWSHandler(fetchHandler: FetchHandler): UWSHTTPHandler {
  return (nodeRes, nodeReq) => {
    const request = new UWSRequest({ req: nodeReq, res: nodeRes });
    const response = fetchHandler(request);
    if (response instanceof Promise) {
      response.then((resolved) => sendUWSResponse(nodeRes, resolved));
    } else {
      sendUWSResponse(nodeRes, response);
    }
  };
}

class UWSServer implements Server {
  readonly runtime = "uws";
  readonly uws: Server["uws"] = {};
  readonly options: Server["options"];
  readonly fetch: ServerHandler;

  #wait: ReturnType<typeof createWaitUntil>;
  #listeningPromise?: Promise<void>;
  #listeningInfo?: { hostname?: string; port: number };
  #listenSocket?: us_listen_socket;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };
    this.options.uws ??= {};

    for (const plugin of options.plugins || []) {
      plugin(this);
    }
    errorPlugin(this);

    this.fetch = wrapFetch(this);
    this.#wait = createWaitUntil();

    if (!options.manual) {
      this.serve();
    }
  }

  serve(): Promise<this> {
    if (this.uws?.server) {
      return Promise.resolve(this.#listeningPromise).then(() => this);
    }
    this.#listeningPromise = (async () => {
      const uws = await import("uWebSockets.js").catch((error) => {
        console.error(
          "Please install uWebSockets.js: `npm install uWebSockets.js`",
        );
        throw error;
      });
      this.uws!.server =
        this.options.uws &&
        "cert_file_name" in this.options.uws &&
        this.options.uws.cert_file_name &&
        "key_file_name" in this.options.uws &&
        this.options.uws.key_file_name
          ? uws.SSLApp(this.options.uws)
          : uws.App(this.options.uws);
      const handler = toUWSHandler(this.fetch);
      this.uws!.server.any("/*", handler);
      const { port } = resolvePortAndHost(this.options);
      await new Promise<void>((resolve, reject) => {
        this.uws!.server!.listen(
          port,
          (listenSocket: us_listen_socket | false) => {
            if (listenSocket) {
              this.#listenSocket = listenSocket;
              const { port, hostname } = resolvePortAndHost({
                ...this.options,
                port: uws.us_socket_local_port(listenSocket),
              });
              this.#listeningInfo = { hostname, port };
              printListening(this.options, this.url);
              resolve();
            } else {
              reject(new Error("Failed to listen on port " + port));
            }
          },
        );
      });
    })();
    return this.#listeningPromise.then(() => this);
  }

  get url(): string | undefined {
    return this.#listeningInfo
      ? fmtURL(
          this.#listeningInfo.hostname,
          this.#listeningInfo.port,
          !!(
            this.options.uws &&
            "cert_file_name" in this.options.uws &&
            this.options.uws.cert_file_name &&
            "key_file_name" in this.options.uws &&
            this.options.uws.key_file_name
          ),
        )
      : undefined;
  }

  ready(): Promise<this> {
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  async close(): Promise<void> {
    await this.#wait.wait();
    if (this.uws?.server && this.#listenSocket) {
      const { us_listen_socket_close } = await import("uWebSockets.js");
      us_listen_socket_close(this.#listenSocket);
      this.uws.server.close();
      this.#listenSocket = undefined;
    }
  }
}
