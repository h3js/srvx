import type { ServerMiddleware, ServerOptions } from "srvx";
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
  if (options._prod) {
    // Start the server directly in the current process
    await serve();
  } else {
    // Fork a child process to run the server with watch mode
    const isBun = !!process.versions.bun;
    const isDeno = !!process.versions.deno;
    const isNode = !isBun && !isDeno;
    const runtimeArgs: string[] = ["--watch"];
    if (isNode || isDeno) {
      runtimeArgs.push(
        ...[".env", ".env.local"]
          .filter((f) => existsSync(f))
          .map((f) => `--env-file=${f}`),
      );
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
    const { serve: srvxServe } = await import("srvx");
    const { serveStatic } = await import("srvx/static");
    const { log } = await import("srvx/log");
    const entry = await loadEntry(options);

    const staticDir = resolve(options._dir, options._static);
    options._static = existsSync(staticDir) ? staticDir : "";

    const server = await srvxServe({
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
    }).ready();

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
};

async function loadEntry(opts: CLIOptions): Promise<ServerOptions> {
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
      return {
        fetch: () =>
          renderError(
            `No server entry file found.\nPlease specify an entry file or ensure one of the default entries exists (${defaultEntries.join(", ")}).`,
            404,
            "No Server Entry",
          ),
        ...opts,
      };
    }

    // Convert to file:// URL for consistent imports
    const entryURL = opts._entry.startsWith("file://")
      ? opts._entry
      : pathToFileURL(resolve(opts._entry)).href;

    // Import the user file
    const entryModule = await import(entryURL);
    return {
      fetch: () =>
        renderError(
          `The entry file "${relative(".", opts._entry)}" does not export a valid fetch handler.`,
          500,
          "Invalid Entry",
        ),
      ...entryModule.default,
      ...opts,
    };
  } catch (error) {
    console.error(c.red(`${c.bold(opts._entry)}`));
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

async function version() {
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  return `srvx v${pkg.version}\n${runtime()}`;
}

function runtime() {
  if (process.versions.bun) {
    return `bun v${process.versions.bun}`;
  } else if (process.versions.deno) {
    return `deno v${process.versions.deno}`;
  } else {
    return `node v${process.versions.node}`;
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
${c.gray("$")} ${c.cyan(command)} ${c.gray("./server.ts")}         ${c.gray("# Start development server")}
${c.gray("$")} ${c.cyan(command)} --prod              ${c.gray("# Start production  server")}
${c.gray("$")} ${c.cyan(command)} --port=8080         ${c.gray("# Listen on port 8080")}
${c.gray("$")} ${c.cyan(command)} --host=localhost    ${c.gray("# Bind to localhost only")}
${c.gray("$")} ${c.cyan(command)} --tls --cert=cert.pem --key=key.pem  ${c.gray("# Enable TLS (HTTPS/HTTP2)")}

${c.bold("ARGUMENTS")}

  ${c.yellow("<entry>")}                  Server entry path to serve.
                           Default: ${defaultEntries.map((e) => c.cyan(e)).join(", ")} ${c.gray(`(${defaultExts.join(",")})`)}

${c.bold("OPTIONS")}

  ${c.green("-p, --port")} ${c.yellow("<port>")}        Port to listen on (default: ${c.yellow("3000")})
  ${c.green("--host")} ${c.yellow("<host>")}            Host to bind to (default: all interfaces)
  ${c.green("-s, --static")} ${c.yellow("<dir>")}       Serve static files from the specified directory (default: ${c.yellow("public")})
  ${c.green("--prod")}                   Run in production mode (no watch, no debug)
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
