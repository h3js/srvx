import type { NodeHttpHandler, ServerRequest } from "srvx";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { existsSync } from "node:fs";

import type { CLIOptions, LoadEntryResult } from "./cli.ts";

type InterceptListenResult<T> = { res?: T; listenHandler?: NodeHttpHandler };

type LoadEntryContext = {
  defaultEntries: string[];
  defaultExts: string[];
  interceptListen: <T = unknown>(
    cb: () => T | Promise<T>,
  ) => Promise<InterceptListenResult<T>>;
  renderError: (error: unknown, status?: number, title?: string) => Response;
  colors?: {
    red: (input: string) => string;
  };
};

export async function loadEntry(
  opts: CLIOptions,
  ctx: LoadEntryContext,
): Promise<LoadEntryResult> {
  try {
    // Guess entry if not provided
    if (!opts._entry) {
      for (const entry of ctx.defaultEntries) {
        for (const ext of ctx.defaultExts) {
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
      const _error = `No server entry file found.\nPlease specify an entry file or ensure one of the default entries exists (${ctx.defaultEntries.join(", ")}).`;
      return {
        _error,
        fetch: () => ctx.renderError(_error, 404, "No Server Entry"),
        ...opts,
      };
    }

    // Convert to file:// URL for consistent imports
    const entryURL = opts._entry.startsWith("file://")
      ? opts._entry
      : pathToFileURL(resolve(opts._entry)).href;

    // Import the user file
    const { res: mod, listenHandler } = await ctx.interceptListen(
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
      fetchHandler = () => ctx.renderError(_error!, 500, "Invalid Entry");
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
        const msg = `\nMake sure you're using Node.js v22.18+ or v24+ for TypeScript support (current version: ${process.versions.node})\n\n`;
        console.error(ctx.colors?.red ? ctx.colors.red(msg) : msg);
      } else if (/"\.(m|c)?tsx"/g.test(message)) {
        const msg = `\nYou need a compatible loader for JSX support (Deno, Bun or srvx --register jiti/register)\n\n`;
        console.error(ctx.colors?.red ? ctx.colors.red(msg) : msg);
      }
    }
    throw error;
  }
}
