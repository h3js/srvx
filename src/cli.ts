import type {
  NodeHttpHandler,
  Server,
  ServerMiddleware,
  ServerOptions,
  ServerRequest,
} from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, relative, resolve } from "node:path";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { Colors as c } from "./_utils.cli.ts";

// prettier-ignore
const defaultEntries = ["server", "src/server", "index", "src/index"];
const defaultExts = [".mts", ".ts", ".cts", ".js", ".mjs", ".cjs"];

const args = process.argv.slice(2);
const options = parseArgs(args);

// Running in a child process
if (process.send) {
  setupProcessErrorHandlers();
  await serve();
}

export async function main(mainOpts: MainOpts): Promise<void> {
  setupProcessErrorHandlers();

  // Handle version flag
  if (options._version) {
    console.log(await version());
    process.exit(0);
  }
  // Handle help flag
  if (options._help) {
    console.log(usage(mainOpts));
    process.exit(options._help ? 0 : 1);
  }
  if (options._prod && !options._import) {
    // Start the server directly in the current process
    await serve();
  } else {
    // Fork a child process with additional args
    const isBun = !!process.versions.bun;
    const isDeno = !!process.versions.deno;
    const isNode = !isBun && !isDeno;
    const runtimeArgs: string[] = [];
    if (!options._prod) {
      runtimeArgs.push("--watch");
    }
    if (isNode || isDeno) {
      runtimeArgs.push(
        ...[".env", ".env.local"]
          .filter((f) => existsSync(f))
          .map((f) => `--env-file=${f}`),
      );
    }
    if (isNode) {
      const [major, minor] = process.versions.node.split(".");
      if (major === "22" && +minor >= 6) {
        runtimeArgs.push("--experimental-strip-types");
      }
      if (options._import) {
        runtimeArgs.push(`--import=${options._import}`);
      }
    }
    const child = fork(fileURLToPath(import.meta.url), args, {
      execArgv: [...process.execArgv, ...runtimeArgs].filter(Boolean),
    });
    child.on("error", (error) => {
      console.error("Error in child process:", error);
      process.exit(1);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Child process exited with code ${code}`);
        process.exit(code);
      }
    });
  }
}

async function serve() {
  try {
    // Load server entry file and create a new server instance
    const entry = await loadEntry(options);

    const forceUseNode = entry._legacyNode;
    const { serve: srvxServe } = forceUseNode
      ? await import("srvx/node")
      : await import("srvx");
    const { serveStatic } = await import("srvx/static");
    const { log } = await import("srvx/log");

    const staticDir = resolve(options._dir, options._static);
    options._static = existsSync(staticDir) ? staticDir : "";

    const server = srvxServe({
      error: (error) => {
        console.error(error);
        return renderError(error);
      },
      middleware: [
        log(),
        options._static
          ? serveStatic({
              dir: options._static,
            })
          : undefined,
        ...(entry.middleware || []),
      ].filter(Boolean) as ServerMiddleware[],
      ...entry,
    });

    globalThis.__srvx__ = server;
    await server.ready();
    await globalThis.__srvx_listen_cb__?.();

    printInfo();

    // Keep the process alive with proper cleanup
    const cleanup = () => {
      // TODO: force close seems not working properly (when fixed, we should await for it)
      server.close(true).catch(() => {});
      process.exit(0);
    };
    // Handle Ctrl+C
    process.on("SIGINT", () => {
      console.log(c.gray("\rStopping server..."));
      cleanup();
    });
    // Handle termination signal (watcher)
    process.on("SIGTERM", cleanup);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

declare global {
  var __srvx_version__: string | undefined;
  var __srvx__: Server;
  var __srvx_listen_cb__: () => void;
}

type MainOpts = {
  command: string;
  docs: string;
  issues: string;
};

type CLIOptions = Partial<ServerOptions> & {
  _entry: string;
  _dir: string;
  _prod: boolean;
  _static: string;
  _help?: boolean;
  _version?: boolean;
  _import?: string;
};

async function loadEntry(
  opts: CLIOptions,
): Promise<ServerOptions & { _legacyNode?: boolean; _error?: string }> {
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
        fetch: () => renderError(_error, 404, "No Server Entry"),
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
      mod.fetch || mod.default?.fetch || mod.default?.default?.fetch;

    // Upgrade legacy Node.js handler
    let _legacyNode = false;
    if (!fetchHandler) {
      const nodeHandler =
        listenHandler ||
        (typeof mod.default === "function" ? mod.default : undefined);
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
      fetchHandler = () => renderError(_error, 500, "Invalid Entry");
    }

    return {
      ...mod,
      ...mod.default,
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
          c.red(
            `\nMake sure you're using Node.js v22.18+ or v24+ for TypeScript support (current version: ${process.versions.node})\n\n`,
          ),
        );
      } else if (/"\.(m|c)?tsx"/g.test(message)) {
        console.error(
          c.red(
            `\nYou need a compatible loader for JSX support (Deno, Bun or srvx --register jiti/register)\n\n`,
          ),
        );
      }
    }
    if (error instanceof Error) {
      Error.captureStackTrace?.(error, serve);
    }
    throw error;
  }
}

function renderError(
  error: unknown,
  status = 500,
  title = "Server Error",
): Response {
  let html = `<!DOCTYPE html><html><head><title>${title}</title></head><body>`;
  if (options._prod) {
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

function printInfo() {
  if (options._entry) {
    console.log(
      c.gray(
        `${c.bold(c.gray("λ"))} Server entry: ${c.cyan("./" + relative(".", options._entry))} ${options._prod ? "" : c.gray("(watching for changes)")}`,
      ),
    );
  }
  if (options._static) {
    console.log(
      c.gray(
        `${c.bold(c.gray("⊟"))} Static files: ${c.cyan("./" + relative(".", options._static) + "/")}`,
      ),
    );
  }
}

async function interceptListen<T = unknown>(
  cb: () => T | Promise<T>,
): Promise<{ res?: T; listenHandler?: NodeHttpHandler }> {
  const http = process.getBuiltinModule("node:http");
  if (!http || !http.Server) {
    const res = await cb();
    return { res };
  }
  const originalListen = http.Server.prototype.listen;
  let res: T;
  let listenHandler: NodeHttpHandler | undefined;
  try {
    // @ts-expect-error
    http.Server.prototype.listen = function (this: Server, arg1, arg2) {
      // https://github.com/nodejs/node/blob/af77e4bf2f8bee0bc23f6ee129d6ca97511d34b9/lib/_http_server.js#L557
      // @ts-expect-error
      listenHandler = this._events.request;
      if (Array.isArray(listenHandler)) {
        listenHandler = listenHandler[0]; // Bun compatibility
      }

      // Restore original listen method
      http.Server.prototype.listen = originalListen;

      // Defer callback execution
      globalThis.__srvx_listen_cb__ = [arg1, arg2].find(
        (arg) => typeof arg === "function",
      );

      // Return a deferred proxy for the server instance
      return new Proxy(
        {},
        {
          get(_, prop) {
            const server = globalThis.__srvx__;
            // @ts-expect-error
            return server?.node?.server?.[prop];
          },
        },
      );
    };
    res = await cb();
  } finally {
    http.Server.prototype.listen = originalListen;
  }
  return { res, listenHandler };
}

async function version() {
  const version = globalThis.__srvx_version__ || "unknown";
  return `srvx ${version}\n${runtime()}`;
}

function runtime() {
  if (process.versions.bun) {
    return `bun ${process.versions.bun}`;
  } else if (process.versions.deno) {
    return `deno ${process.versions.deno}`;
  } else {
    return `node ${process.versions.node}`;
  }
}

function parseArgs(args: string[]): CLIOptions {
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      prod: { type: "boolean" },
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      static: { type: "string", short: "s" },
      import: { type: "string" },
      tls: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });

  const input = positionals[0] || ".";
  let dir: string;
  let entry: string = "";
  if (extname(input) === "") {
    dir = resolve(input);
  } else {
    entry = resolve(input);
    dir = dirname(entry);
  }

  return {
    _dir: dir,
    _entry: entry,
    _prod: values.prod ?? process.env.NODE_ENV === "production",
    _help: values.help,
    _static: values.static || "public",
    _version: values.version,
    _import: values.import,
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    hostname: values.host,
    tls: values.tls ? { cert: values.cert, key: values.key } : undefined,
  };
}

function example() {
  const useTs = !options._entry /* help */ || options._entry.endsWith(".ts");
  return `${c.bold(c.gray("// server.ts"))}
${c.magenta("export default")} {
  ${c.cyan("fetch")}(req${useTs ? ": Request" : ""}) {
    ${c.magenta("return")} new Response(${c.green('"Hello, World!"')});
  }
}`;
}

export function usage(mainOpts: MainOpts): string {
  const command = mainOpts.command;
  return `
${c.cyan(command)} - Start an HTTP server with the specified entry path.

${c.bold("USAGE")}
${existsSync(options._entry) ? "" : `\n${example()}\n`}
${c.gray("# srvx [options] [entry]")}
${c.gray("$")} ${c.cyan(command)} ${c.gray("./server.ts")}            ${c.gray("# Start development server")}
${c.gray("$")} ${c.cyan(command)} --prod                 ${c.gray("# Start production  server")}
${c.gray("$")} ${c.cyan(command)} --port=8080            ${c.gray("# Listen on port 8080")}
${c.gray("$")} ${c.cyan(command)} --host=localhost       ${c.gray("# Bind to localhost only")}
${c.gray("$")} ${c.cyan(command)} --import=jiti/register ${c.gray(`# Enable ${c.url("jiti", "https://github.com/unjs/jiti")} loader`)}
${c.gray("$")} ${c.cyan(command)} --tls --cert=cert.pem --key=key.pem  ${c.gray("# Enable TLS (HTTPS/HTTP2)")}


${c.bold("ARGUMENTS")}

  ${c.yellow("<entry>")}                  Server entry path to serve.
                           Default: ${defaultEntries.map((e) => c.cyan(e)).join(", ")} ${c.gray(`(${defaultExts.join(",")})`)}

${c.bold("OPTIONS")}

  ${c.green("-p, --port")} ${c.yellow("<port>")}        Port to listen on (default: ${c.yellow("3000")})
  ${c.green("--host")} ${c.yellow("<host>")}            Host to bind to (default: all interfaces)
  ${c.green("-s, --static")} ${c.yellow("<dir>")}       Serve static files from the specified directory (default: ${c.yellow("public")})
  ${c.green("--prod")}                   Run in production mode (no watch, no debug)
  ${c.green("--import")} ${c.yellow("<loader>")}        ES module to preload
  ${c.green("--tls")}                    Enable TLS (HTTPS/HTTP2)
  ${c.green("--cert")} ${c.yellow("<file>")}            TLS certificate file
  ${c.green("--key")}  ${c.yellow("<file>")}            TLS private key file
  ${c.green("-h, --help")}               Show this help message
  ${c.green("-v, --version")}            Show server and runtime versions

${c.bold("ENVIRONMENT")}

  ${c.green("PORT")}                     Override port
  ${c.green("HOST")}                     Override host
  ${c.green("NODE_ENV")}                 Set to ${c.yellow("production")} for production mode.

➤ ${c.url("Documentation", mainOpts.docs || "https://srvx.h3.dev")}
➤ ${c.url("Report issues", mainOpts.issues || "https://github.com/h3js/srvx/issues")}
`.trim();
}

function setupProcessErrorHandlers() {
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    process.exit(1);
  });
}
