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

    // Options the entry passed to its *own* `serve()` call. The loader constructs
    // that server but returns before it ever listens, so anything only reachable
    // through `options` (TLS above all) is lost unless the CLI forwards it here.
    //
    // Only listener-level options are forwarded. `middleware`/`plugins` are
    // deliberately excluded: the intercepted server already folded them into
    // `loaded.fetch` via `wrapFetch()`, so re-applying them would run them twice.
    // `port`/`hostname` stay CLI-owned (see "Port and host precedence" in
    // docs/1.guide/10.cli.md).
    const nested = loaded.srvxServer?.options as Partial<ServerOptions> | undefined;

    // Mutual TLS reaches the listener through node server options (`ca` /
    // `requestCert`, written by `mtlsPlugin()`), which only srvx's Node.js adapter
    // understands. Re-serving such an entry through a native Deno/Bun adapter
    // would silently drop the client-certificate requirement — the same class of
    // downgrade one level down — so serve it with `srvx/node` instead.
    const nestedNode = nested?.node as Record<string, unknown> | undefined;
    const nestedMTLS = !!nestedNode && ("requestCert" in nestedNode || "ca" in nestedNode);
    if (nestedMTLS && loaded.srvxServer?.runtime !== "node") {
      throw new Error(
        `[srvx] The server entry configures mutual TLS, which requires srvx's Node.js adapter (import { serve } from "srvx/node").`,
      );
    }

    const { serve: srvxServe } =
      loaded.nodeCompat || nestedMTLS ? await import("srvx/node") : await import("srvx");
    const { staticMiddleware } = await import("srvx/static");
    const { loggerMiddleware } = await import("srvx/log");

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
    // Entry-level TLS is honored whether it arrives as a module export or through
    // the entry's own intercepted `serve({ tls })` call — dropping the latter
    // served TLS/mTLS entries over plaintext HTTP with no warning.
    let tls = serverOptions.tls ?? nested?.tls;
    let protocol = serverOptions.protocol ?? nested?.protocol;
    if (cliOpts.tls) {
      if (!cliOpts.cert || !cliOpts.key) {
        throw new Error("--tls requires both --cert and --key.");
      }
      tls = { cert: cliOpts.cert, key: cliOpts.key };
      protocol = undefined; // explicit flags win over an entry's `protocol: "http"`
    }

    // Carries `mtlsPlugin()`'s `ca`/`requestCert`/`rejectUnauthorized` plus any raw
    // node server options the entry set. Module exports win over the nested call.
    const nodeOptions =
      nested?.node || serverOptions.node
        ? ({ ...nested?.node, ...serverOptions.node } as ServerOptions["node"])
        : undefined;

    if (!process.env.SRVX_CLUSTER_WORKER) {
      printInfo(cliOpts, loaded);
    }
    server = srvxServe({
      ...serverOptions,
      gracefulShutdown: !!cliOpts.prod,
      cluster: cliOpts.prod ? (cliOpts.cluster ?? serverOptions.cluster) : false,
      port: cliOpts.port ?? serverOptions.port,
      hostname: cliOpts.hostname ?? cliOpts.host ?? serverOptions.hostname,
      tls,
      protocol,
      node: nodeOptions,
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
        loggerMiddleware(),
        cliOpts.static
          ? staticMiddleware({
              dir: cliOpts.static,
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
  // Never send a stack trace to a remote client when the
  // process believes it is in production, even if `prod` resolution regresses again.
  // `cliServe` sets NODE_ENV before any request is handled, so it is always set here.
  const safeMode = cliOpts.prod || process.env.NODE_ENV === "production";
  if (safeMode) {
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
