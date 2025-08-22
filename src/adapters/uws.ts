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
  resolveTLSOptions,
} from "../_utils.ts";
import { wrapFetch } from "../_middleware.ts";
import { UWSRequest } from "./_uws/request.ts";
import { sendUWSResponse } from "./_uws/send.ts";
import { errorPlugin } from "../_plugins.ts";

export { FastURL } from "../_url.ts";
export { UWSRequest } from "./_uws/request.ts";
export { UWSRequestHeaders, UWSResponseHeaders } from "./_uws/headers.ts";
export { UWSResponse, UWSResponse as FastResponse } from "./_uws/response.ts";
export { sendUWSResponse } from "./_uws/send.ts";

export function serve(options: ServerOptions): Server {
  return new UWSServer(options);
}

export function toUWSHandler(fetchHandler: FetchHandler): UWSHTTPHandler {
  return (nodeReq, nodeRes) => {
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
  readonly uws: Server["uws"];
  readonly options: Server["options"];
  readonly fetch: ServerHandler;

  #listeningPromise?: Promise<void>;
  #isSecure: boolean;
  #wait: ReturnType<typeof createWaitUntil>;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) {
      plugin(this);
    }
    errorPlugin(this);

    this.fetch = wrapFetch(this);
    this.#wait = createWaitUntil();

    const tls = resolveTLSOptions(this.options);
    this.#isSecure = !!(tls?.cert && tls?.key);
  }

  serve(): Promise<this> {
    if (this.#listeningPromise) {
      return this.#listeningPromise.then(() => this);
    }
    const promise = new Promise<void>((resolve) => {
      // TODO: Implement uws server creation and listening
      printListening(this.options, this.url);
      resolve();
    });
    this.#listeningPromise = promise;
    return promise.then(() => this);
  }

  get url() {
    const { port, hostname } = resolvePortAndHost(this.options);
    return fmtURL(hostname, port, this.#isSecure);
  }

  ready(): Promise<this> {
    return Promise.resolve(this.#listeningPromise).then(() => this);
  }

  async close(): Promise<void> {
    await this.#wait.wait();
    this.uws?.server?.close();
  }
}
