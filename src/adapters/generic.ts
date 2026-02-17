import type { Server, ServerHandler, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";
import { createWaitUntil } from "../_utils.ts";

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

export function serve(options: ServerOptions): Server {
  return new GenericServer(options);
}

class GenericServer implements Server {
  readonly runtime = "generic";
  readonly options: Server["options"];
  readonly fetch: ServerHandler;
  readonly waitUntil: Server["waitUntil"];

  #wait: ReturnType<typeof createWaitUntil>;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);
    errorPlugin(this);

    this.#wait = createWaitUntil();
    this.waitUntil = this.#wait.waitUntil;

    const fetchHandler = wrapFetch(this as unknown as Server);

    this.fetch = (request: Request) => {
      Object.defineProperties(request, {
        waitUntil: { value: this.#wait.waitUntil },
      });
      return Promise.resolve(fetchHandler(request));
    };
  }

  serve(): void {}

  ready(): Promise<Server> {
    return Promise.resolve(this);
  }

  async close(): Promise<void> {
    await this.#wait.wait();
  }
}
