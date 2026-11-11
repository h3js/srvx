// Experimental adapter for scriptc (https://scriptc.dev), which compiles
// TypeScript to a native executable with its own `node:http` and native web
// `Request`/`Response`. The node adapter can't compile there (prototype
// rewiring, `extends IncomingMessage`, function-local classes with `#private`
// fields), so this is a separate driver kept to what scriptc compiles:
//
// - Plain `node:http`: inline `createServer` options, `listen(port, host, cb)`,
//   and only statically typed event listeners (`.once`/`.off` on untyped
//   values don't compile). There is no `Readable.toWeb`, and `res.write()` has
//   no `drain` event, so responses are written without backpressure.
// - Nothing from `_node/` or `_url.ts`: `FastURL`/`FastResponse` are the
//   native classes (scriptc's `Response` is already fast).
// - `gracefulShutdownPlugin` is skipped: it reads `process.on` as a value,
//   which throws under scriptc.

import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { Server, ServerHandler, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";
import { fmtURL, isNullBodyStatus, printListening, resolvePortAndHost } from "../_utils.ts";

export const FastURL: typeof globalThis.URL = URL;
export const FastResponse: typeof globalThis.Response = Response;

/**
 * Create a server for scriptc native executables (experimental).
 *
 * Unlike other adapters, the request is a plain native `Request`: scriptc
 * can't add properties to one (assignment, `Object.defineProperty` and
 * `extends Request` all fail), so `request.ip`, `request.waitUntil`,
 * `request.runtime` and `request.context` are never set. Use
 * `server.waitUntil()` for background tasks. `request.signal` aborts when the
 * client disconnects.
 *
 * HTTP/1.1 only. The `tls`, `protocol`, `node`, `gracefulShutdown`,
 * `trustProxy`, `maxRequestBodySize` and `reusePort` options are ignored.
 *
 * @see https://srvx.h3.dev/guide/scriptc
 */
export function serve(options: ServerOptions): Server {
  return new ScriptcServer(options);
}

class ScriptcServer implements Server {
  readonly runtime = "scriptc";
  readonly options: Server["options"];
  readonly fetch: ServerHandler;
  readonly waitUntil: Server["waitUntil"];

  #server: NodeHttpServer;
  #pending = new Set<Promise<void>>();
  #listening: Promise<this> | undefined;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this);
    errorPlugin(this);

    // Typed equivalent of `createWaitUntil()` (its self-referencing
    // `chained` binding and `Promise.all(Set)` don't compile under scriptc).
    const pending = this.#pending;
    this.waitUntil = (promise: Promise<unknown>): void => {
      let tracked: Promise<void> | undefined;
      tracked = promise
        .then(
          () => {},
          (error: unknown) => console.error(error),
        )
        .finally(() => {
          if (tracked) pending.delete(tracked);
        });
      pending.add(tracked);
    };

    const fetchHandler = wrapFetch(this);
    this.fetch = fetchHandler;

    const silent = this.options.silent;
    this.#server = createServer({}, (req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(fetchHandler, req, res, silent);
    });

    if (!options.manual) {
      this.serve().catch((error: unknown) => {
        if (!silent) console.error("[srvx] Failed to start server:", error);
      });
    }
  }

  // A failed listen stays failed: `serve()` and `ready()` keep rejecting.
  serve(): Promise<this> {
    if (this.#listening) return this.#listening;
    const server = this.#server;
    const { port, hostname } = resolvePortAndHost(this.options);
    this.#listening = new Promise<this>((resolve, reject) => {
      let settled = false;
      server.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      server.listen(port, hostname, () => {
        settled = true;
        printListening(this.options, this.url);
        resolve(this);
      });
    });
    return this.#listening;
  }

  get url(): string | undefined {
    const server = this.#server;
    if (!server.listening) return;
    const addr = server.address();
    if (!addr || typeof addr === "string") return;
    return fmtURL(addr.address, addr.port, false);
  }

  async ready(): Promise<this> {
    if (this.#listening) await this.#listening;
    return this;
  }

  async close(closeActiveConnections?: boolean): Promise<void> {
    const server = this.#server;
    if (closeActiveConnections) server.closeAllConnections();
    const closed = new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    // Also awaits tasks registered while waiting.
    const pending = this.#pending;
    while (pending.size > 0) await Promise.all(Array.from(pending));
    await closed;
  }
}

async function handleRequest(
  fetchHandler: ServerHandler,
  req: IncomingMessage,
  res: ServerResponse,
  silent: boolean | undefined,
): Promise<void> {
  let request: Request;
  try {
    request = toRequest(req, res);
  } catch {
    // Invalid request target or host header.
    res.statusCode = 400;
    res.end();
    return;
  }
  let response: Response;
  try {
    response = await fetchHandler(request);
  } catch (error) {
    if (!silent) console.error("[srvx] Unhandled error in fetch handler:", error);
    return sendError(res);
  }
  try {
    await sendResponse(req, res, response);
  } catch (error) {
    if (!silent) console.error("[srvx] Failed to send response:", error);
    sendError(res);
  }
}

// Characters that would change how the authority of `http://${host}` parses.
const INVALID_HOST_RE = /[\s/?#@\\]/;

function toRequest(req: IncomingMessage, res: ServerResponse): Request {
  const target = req.url || "/";
  let url: string;
  if (target[0] === "/") {
    // Concatenated (not resolved against a base) so `//host/path` stays a path.
    const host = req.headers.host || "localhost";
    if (INVALID_HOST_RE.test(host)) throw new TypeError("Invalid host header");
    url = new URL(`http://${host}${target}`).href;
  } else if (target.startsWith("http://") || target.startsWith("https://")) {
    // Absolute-form request target (RFC 9112 §3.2.2).
    url = new URL(target).href;
  } else {
    throw new TypeError("Invalid request target");
  }

  const method = req.method || "GET";
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);

  // Aborted when the connection closes before the response is fully sent.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal: abort.signal });
  }
  return new Request(url, {
    method,
    headers,
    signal: abort.signal,
    body: toBodyStream(req, res),
    duplex: "half",
  } as RequestInit);
}

// Pushes `data` events into a web stream, pausing the incoming message until
// the consumer pulls again. A body left unread is drained once the response
// is done so the connection can be reused.
function toBodyStream(req: IncomingMessage, res: ServerResponse): ReadableStream<Uint8Array> {
  let done = false;
  const discard = () => {
    if (done) return;
    done = true;
    req.resume();
  };
  res.on("finish", discard);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Uint8Array) => {
        if (done) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize || 0) <= 0) req.pause();
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        controller.close();
      });
      req.on("error", (error: Error) => {
        if (done) return;
        done = true;
        controller.error(error);
      });
    },
    pull() {
      if (!done) req.resume();
    },
    cancel() {
      discard();
    },
  });
}

async function sendResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value: string, key: string) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  const body = response.body;
  if (!body || req.method === "HEAD" || isNullBodyStatus(response.status)) {
    if (body) body.cancel().catch(() => {});
    res.end();
    return;
  }

  const reader = body.getReader();
  let closed = false;
  res.on("close", () => {
    closed = true;
    reader.cancel().catch(() => {});
  });
  while (!closed) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(value);
  }
  res.end();
}

function sendError(res: ServerResponse): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // Status line already sent; the only way to signal failure is to drop the connection.
    res.destroy();
    return;
  }
  // Drop headers copied from the failed response (e.g. `content-type`).
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = 500;
  // Overwrite a `statusText` copied from the failed response (scriptc writes
  // an empty reason phrase as-is, unlike Node).
  res.statusMessage = "Internal Server Error";
  res.end();
}
