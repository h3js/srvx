import type { NodeHttpHandler, ServerOptions, ServerRequest } from "srvx";
import { pathToFileURL } from "node:url";
import * as nodeHTTP from "node:http";
import { relative, resolve } from "node:path";
import { existsSync } from "node:fs";

declare global {
  // Assigned at runtime by the CLI server bootstrap
  // (used for legacy Node.js handler detection via interceptListen)
  var __srvx__: unknown;
  var __srvx_listen_cb__: unknown;
}

// prettier-ignore
const defaultEntries = ["server", "index", "src/server", "src/index", "server/index"];
// prettier-ignore
const defaultExts = [".mts", ".ts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".tsx"];

export type CLIOptions = Partial<ServerOptions> & {
  _entry: string;
  _dir: string;
  _prod: boolean;
  _static: string;
  _help?: boolean;
  _version?: boolean;
  _import?: string;
};

export type LoadEntryResult = ServerOptions & {
  _legacyNode?: boolean;
  _error?: string;
};

export async function loadEntry(opts: CLIOptions): Promise<LoadEntryResult> {
  try {
    // Guess entry if not provided
    if (!opts._entry) {
      for (const entry of defaultEntries) {
        for (const ext of defaultExts) {
          const entryPath = resolve(opts._dir, `${entry}${ext}`);
          if (existsSync(entryPath)) {
            opts._entry = entryPath;
            break;
          }
        }
        if (opts._entry) break;
      }
    }

    if (!opts._entry) {
      const _error = `No server entry file found.\nPlease specify an entry file or ensure one of the default entries exists (${defaultEntries.join(", ")}).`;
      return {
        _error,
        fetch: () => renderError(opts._prod, _error, 404, "No Server Entry"),
        ...opts,
      };
    }

    // Convert to file:// URL for consistent imports
    const entryURL = opts._entry.startsWith("file://")
      ? opts._entry
      : pathToFileURL(resolve(opts._entry)).href;

    // Import the user file
    const { res: mod, listenHandler } = await interceptListen(
      () => import(entryURL),
    );

    let fetchHandler =
      mod?.fetch || mod?.default?.fetch || mod?.default?.default?.fetch;

    // Upgrade legacy Node.js handler
    let _legacyNode = false;
    if (!fetchHandler) {
      const nodeHandler =
        listenHandler ||
        (typeof mod?.default === "function" ? mod.default : undefined);
      if (nodeHandler) {
        _legacyNode = true;
        const { callNodeHandler } = await import("./adapters/_node/call.ts");
        fetchHandler = (webReq: ServerRequest) =>
          callNodeHandler(nodeHandler, webReq);
      }
    }

    // Runtime warning if no fetch handler is found
    let _error: string | undefined;
    if (!fetchHandler) {
      _error = `The entry file "${relative(".", opts._entry)}" does not export a valid fetch handler.`;
      fetchHandler = () =>
        renderError(opts._prod, _error!, 500, "Invalid Entry");
    }

    return {
      ...mod,
      ...mod?.default,
      ...opts,
      _error,
      _legacyNode,
      fetch: fetchHandler,
    };
  } catch (error) {
    if ((error as { code?: string })?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
      const message = String(error);
      if (/"\.(m|c)?ts"/g.test(message)) {
        console.error(
          `\nMake sure you're using Node.js v22.18+ or v24+ for TypeScript support (current version: ${process.versions.node})\n\n`,
        );
      } else if (/"\.(m|c)?tsx"/g.test(message)) {
        console.error(
          `\nYou need a compatible loader for JSX support (Deno, Bun or srvx --register jiti/register)\n\n`,
        );
      }
    }
    throw error;
  }
}

function renderError(
  prod: boolean,
  error: unknown,
  status = 500,
  title = "Server Error",
): Response {
  let html = `<!DOCTYPE html><html><head><title>${title}</title></head><body>`;
  if (prod) {
    html += `<h1>${title}</h1><p>Something went wrong while processing your request.</p>`;
  } else {
    html += /* html */ `
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f8f9fa; color: #333; }
      h1 { color: #dc3545; }
      pre { background: #fff; padding: 10px; border-radius: 5px; overflow: auto; }
      code { font-family: monospace; }
      #error { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; }
    </style>
    <div id="error"><h1>${title}</h1><pre>${error instanceof Error ? error.stack || error.message : String(error)}</pre></div>
    `;
  }

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function interceptListen<T = unknown>(
  cb: () => T | Promise<T>,
): Promise<{ res?: T; listenHandler?: NodeHttpHandler }> {
  const originalListen = nodeHTTP.Server.prototype.listen;
  let res: T;
  let listenHandler: NodeHttpHandler | undefined;
  try {
    // @ts-expect-error
    nodeHTTP.Server.prototype.listen = function (
      this: any,
      arg1: any,
      arg2: any,
    ) {
      // https://github.com/nodejs/node/blob/af77e4bf2f8bee0bc23f6ee129d6ca97511d34b9/lib/_http_server.js#L557
      // @ts-expect-error
      listenHandler = this._events.request;
      if (Array.isArray(listenHandler)) {
        listenHandler = listenHandler[0]; // Bun compatibility
      }

      // Restore original listen method
      nodeHTTP.Server.prototype.listen = originalListen;

      // Defer callback execution
      globalThis.__srvx_listen_cb__ = [arg1, arg2].find(
        (arg) => typeof arg === "function",
      );

      // Return a deferred proxy for the server instance
      return new Proxy(
        {},
        {
          get(_, prop) {
            const server = (globalThis as any).__srvx__;
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
}
