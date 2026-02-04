import type { NodeHttpHandler, Server, ServerHandler, ServerRequest } from "srvx";
import { pathToFileURL } from "node:url";
import * as nodeHTTP from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export const defaultExts: string[] = [".mjs", ".js", ".mts", ".ts"];

export const defaultEntries: string[] = ["server", "server/index", "src/server", "server/server"];

/**
 * Options for loading a server entry module.
 */
export type LoadOptions = {
  /**
   * Path or URL to the server entry file.
   *
   * If not provided, common entry points will be searched automatically.
   */
  entry?: string;

  /**
   * Base directory for resolving relative paths.
   *
   * @default "."
   */
  dir?: string;

  /**
   * Set to `false` to disable interception of `http.Server.listen` to detect legacy handlers.
   *
   * @default true
   */
  interceptHttpListen?: boolean;

  /**
   * Set to `false` to disable Node.js handler (req, res) compatibility.
   */
  nodeCompat?: boolean;

  /**
   * Hook called after the module is loaded to allow for custom processing.
   *
   * You can return a modified version of the module if needed.
   */
  onLoad?: (module: unknown) => any;
};

/**
 * Result of loading a server entry module.
 */
export type LoadedServerEntry = {
  /**
   * The web fetch handler extracted from the loaded module.
   *
   * This is resolved from `module.fetch`, `module.default.fetch`,
   * or upgraded from a legacy Node.js handler.
   */
  fetch?: ServerHandler;

  /**
   * The raw loaded module.
   */
  module?: any;

  /**
   * Whether the handler was upgraded from a legacy Node.js HTTP handler.
   *
   * When `true`, the original module exported a Node.js-style `(req, res)` handler
   * that has been wrapped for web fetch compatibility.
   */
  nodeCompat?: boolean;

  /**
   * The resolved `file://` URL of the loaded entry module.
   */
  url?: string;

  /**
   * Whether the specified entry file was not found.
   *
   * When `true`, no valid entry point could be located.
   */
  notFound?: boolean;
};

export async function loadServerEntry(opts: LoadOptions): Promise<LoadedServerEntry> {
  // Guess entry if not provided
  let entry: string | undefined = opts.entry;
  if (entry) {
    entry = resolve(opts.dir || ".", entry);
    if (!existsSync(entry)) {
      return { notFound: true };
    }
  } else {
    for (const defEntry of defaultEntries) {
      for (const defExt of defaultExts) {
        const entryPath = resolve(opts.dir || ".", `${defEntry}${defExt}`);
        if (existsSync(entryPath)) {
          entry = entryPath;
          break;
        }
      }
      if (entry) break;
    }
    if (!entry) {
      return { notFound: true };
    }
  }

  // Convert to file:// URL for consistent imports
  const url = entry.startsWith("file://") ? entry : pathToFileURL(resolve(entry)).href;

  // Import the user file
  let mod: any;
  let listenHandler: NodeHttpHandler | undefined;
  try {
    if (opts.interceptHttpListen !== false) {
      const loaded = await interceptListen(() => import(url));
      mod = loaded.res;
      listenHandler = loaded.listenHandler;
    } else {
      mod = await import(url);
    }
  } catch (error) {
    if ((error as { code?: string })?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
      const message = String(error);
      if (/"\.(m|c)?ts"/g.test(message)) {
        throw new Error(
          `Make sure you're using Node.js v22.18+ or v24+ for TypeScript support (current version: ${process.versions.node})`,
          { cause: error },
        );
      } else if (/"\.(m|c)?tsx"/g.test(message)) {
        throw new Error(
          `You need a compatible loader for JSX support (Deno, Bun or srvx --register jiti/register)`,
          { cause: error },
        );
      }
    }
    throw error;
  }

  mod = (await opts?.onLoad?.(mod)) || mod;

  let fetchHandler = mod?.fetch || mod?.default?.fetch || mod?.default?.default?.fetch;
  if (!fetchHandler && typeof mod?.default === "function" && mod.default.length < 2) {
    fetchHandler = mod.default;
  }

  // Upgrade legacy Node.js handler
  let nodeCompat = false;
  if (!fetchHandler && opts.nodeCompat !== false) {
    const nodeHandler =
      listenHandler || (typeof mod?.default === "function" ? mod.default : undefined);
    if (nodeHandler) {
      nodeCompat = true;
      const { fetchNodeHandler } = await import("srvx/node");
      fetchHandler = (webReq: ServerRequest) => fetchNodeHandler(nodeHandler, webReq);
    }
  }

  return {
    module: mod,
    nodeCompat,
    url,
    fetch: fetchHandler,
  };
}

// Concurrency lock to prevent parallel interceptions
let _interceptQueue: Promise<unknown> = Promise.resolve();

async function interceptListen<T = unknown>(
  cb: () => T | Promise<T>,
): Promise<{ res?: T; listenHandler?: NodeHttpHandler }> {
  // Chain onto the queue to ensure sequential execution
  const result = _interceptQueue.then(async () => {
    const originalListen = nodeHTTP.Server.prototype.listen;
    let res: T;
    let listenHandler: NodeHttpHandler | undefined;
    try {
      // @ts-expect-error
      nodeHTTP.Server.prototype.listen = function (this: Server, arg1, arg2) {
        // https://github.com/nodejs/node/blob/af77e4bf2f8bee0bc23f6ee129d6ca97511d34b9/lib/_http_server.js#L557
        // @ts-expect-error
        listenHandler = this._events.request;
        if (Array.isArray(listenHandler)) {
          listenHandler = listenHandler[0]; // Bun compatibility
        }

        // Restore original listen method
        nodeHTTP.Server.prototype.listen = originalListen;

        // Defer callback execution
        const listenCallback = [arg1, arg2].find((arg) => typeof arg === "function");
        setImmediate(() => {
          listenCallback?.();
        });

        // Return a deferred proxy for the server instance
        return new Proxy(
          {},
          {
            get(_, prop) {
              const server = globalThis.__srvx__;
              if (!server && prop === "address") {
                return () => ({ address: "", family: "", port: 0 });
              }
              // @ts-expect-error
              return server?.node?.server?.[prop];
            },
          },
        );
      };
      res = await cb();
    } finally {
      nodeHTTP.Server.prototype.listen = originalListen;
    }
    return { res, listenHandler };
  });

  // Update queue to point to this operation (swallow errors for queue chaining)
  _interceptQueue = result.catch(() => {});

  return result;
}
