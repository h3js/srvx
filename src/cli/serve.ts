import type { Server, ServerMiddleware, ServerOptions } from "../types.ts";
import type { CLIOptions } from "./types.ts";
import { dirname, relative, resolve } from "node:path";
import { loadServerEntry } from "../loader.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as c from "./_utils.ts";

export const NO_ENTRY_ERROR = "No server entry or public directory found";

export async function cliServe(cliOpts: CLIOptions): Promise<void> {
  try {
    // Set default NODE_ENV
    if (!process.env.NODE_ENV) {
      process.env.NODE_ENV = cliOpts.prod ? "production" : "development";
    }

    let server: Server | undefined;

    // Load server entry file and create a new server instance
    const loaded = await loadServerEntry({
      entry: cliOpts.entry,
      dir: cliOpts.dir,
      get srvxServer() {
        return server;
      },
    });

    const { serve: srvxServe } = loaded.nodeCompat
      ? await import("srvx/node")
      : await import("srvx");
    const { serveStatic } = await import("srvx/static");
    const { log } = await import("srvx/log");

    // F43: an explicit `--static` pointing at a missing dir must error; the
    // implicit `public` default may stay silent.
    const explicitStatic = !!cliOpts.static;
    const staticDir = resolve(
      cliOpts.dir || (loaded.url ? dirname(fileURLToPath(loaded.url)) : "."),
      cliOpts.static || "public",
    );
    if (existsSync(staticDir)) {
      cliOpts.static = staticDir;
    } else if (explicitStatic) {
      throw new Error(`--static directory not found: ${staticDir}`);
    } else {
      cliOpts.static = "";
    }

    if (loaded.notFound && !cliOpts.static) {
      process.send?.({ error: "no-entry" });
      throw new Error(NO_ENTRY_ERROR, { cause: cliOpts });
    }

    const serverOptions = {
      ...loaded.module?.default,
      default: undefined,
      ...loaded.module,
    } as Partial<ServerOptions>;

    // F42: only override the entry module's `tls` when CLI flags actually supply
    // TLS. A bare `--tls` (no cert/key) must error rather than silently downgrade.
    let tls = serverOptions.tls;
    if (cliOpts.tls) {
      if (!cliOpts.cert || !cliOpts.key) {
        throw new Error("--tls requires both --cert and --key.");
      }
      tls = { cert: cliOpts.cert, key: cliOpts.key };
    }

    printInfo(cliOpts, loaded);
    server = srvxServe({
      ...serverOptions,
      gracefulShutdown: !!cliOpts.prod,
      port: cliOpts.port ?? serverOptions.port,
      hostname: cliOpts.hostname ?? cliOpts.host ?? serverOptions.hostname,
      tls,
      error: (error) => {
        console.error(error);
        return renderError(cliOpts, error);
      },
      fetch:
        loaded.fetch ||
        (() =>
          renderError(
            cliOpts,
            loaded.notFound ? "Server Entry Not Found" : "No Fetch Handler Exported",
            501,
          )),
      middleware: [
        log(),
        cliOpts.static
          ? serveStatic({
              dir: cliOpts.static,
              // Dev convenience: browse directories without an index. Off in prod
              // so the structure is never exposed by default, unless the explicit
              // `--dir-listing` / `--no-dir-listing` flag overrides either way.
              dirListing: cliOpts.dirListing ?? !cliOpts.prod,
            })
          : undefined,
        ...(serverOptions.middleware || []),
      ].filter(Boolean) as ServerMiddleware[],
    });
    await server.ready();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

function renderError(
  cliOpts: CLIOptions,
  error: unknown,
  status = 500,
  title = "Server Error",
): Response {
  const safeTitle = escapeHtml(title);
  let html = `<!DOCTYPE html><html><head><title>${safeTitle}</title></head><body>`;
  if (cliOpts.prod) {
    html += `<h1>${safeTitle}</h1><p>Something went wrong while processing your request.</p>`;
  } else {
    html += /* html */ `
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f8f9fa; color: #333; }
      h1 { color: #dc3545; }
      pre { background: #fff; padding: 10px; border-radius: 5px; overflow: auto; }
      code { font-family: monospace; }
      #error { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; }
    </style>
    <div id="error"><h1>${safeTitle}</h1><pre>${escapeHtml(
      error instanceof Error ? error.stack || error.message : String(error),
    )}</pre></div>
    `;
  }

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// F59: escape untrusted text before interpolating into the dev error page HTML.
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function printInfo(cliOpts: CLIOptions, loaded: Awaited<ReturnType<typeof loadServerEntry>>) {
  let entryInfo: string;
  if (loaded.notFound) {
    entryInfo = c.gray(`(create ${c.bold(`server.ts`)})`);
  } else {
    entryInfo = loaded.fetch
      ? c.cyan("./" + relative(".", fileURLToPath(loaded.url!)))
      : c.red(`No fetch handler exported from ${loaded.url}`);
  }
  console.log(c.gray(`${c.bold(c.gray("◆"))} Server handler: ${entryInfo}`));
  let staticInfo: string;
  if (cliOpts.static) {
    staticInfo = c.cyan("./" + relative(".", cliOpts.static) + "/");
  } else {
    staticInfo = c.gray(`(create ${c.bold("public/")} dir)`);
  }
  console.log(c.gray(`${c.bold(c.gray("◇"))} Static files:   ${staticInfo}`));
  console.log("");
}
