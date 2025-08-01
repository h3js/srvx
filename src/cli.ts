import type { ServerMiddleware, ServerOptions } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { Colors as c } from "./_utils.cli.ts";

const args = process.argv.slice(2);
const options = parseArgs(args);

// Running in a child process
if (process.send) {
  setupProcessErrorHandlers();
  await serve();
  console.log(
    c.gray(
      `${c.bold(c.green("λ"))} Request handler: ${c.cyan("./" + relative(".", options._entry))} ${c.gray("(watching for changes)")}`,
    ),
  );
  if (options._static) {
    console.log(
      c.gray(
        `${c.bold(c.magenta("🗀"))} Serving static files from ${c.cyan("./" + relative(".", options._static) + "/")}`,
      ),
    );
  }
}

export async function main(mainOpts: MainOpts): Promise<void> {
  setupProcessErrorHandlers();

  // Handle version flag
  if (options._version) {
    console.log(await version());
    process.exit(0);
  }
  // Handle help flag
  if (options._help || !["dev", "start"].includes(options._command)) {
    console.log(help(mainOpts));
    process.exit(options._help ? 0 : 1);
  }
  if (options._dev) {
    // Fork a child process to run the server with watch mode
    const isNode = !process.versions.bun && !process.versions.deno;
    const child = fork(fileURLToPath(import.meta.url), args, {
      execArgv: [
        ...process.execArgv,
        "--watch",
        isNode ? "--disable-warning=ExperimentalWarning" : "",
        isNode
          ? options._entry.endsWith(".ts")
            ? "--experimental-strip-types"
            : ""
          : "",
      ].filter(Boolean),
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
  } else {
    // Start the server directly in the current process
    console.log(c.gray(`${c.cyan(options._entry)}`));
    await serve();
  }
}

async function serve() {
  try {
    // Load server entry file and create a new server instance
    const { serve } = await import("srvx");
    const { serveStatic } = await import("srvx/static");
    const { log } = await import("srvx/log");
    const entry = await loadEntry(options);

    const staticDir = join(dirname(options._entry), options._static);
    options._static = existsSync(staticDir) ? staticDir : "";

    const server = await serve({
      error: (error) => {
        console.error(error);
        return new Response(renderError(error, options._dev), {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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

    // Keep the process alive with proper cleanup
    const cleanup = () => {
      // TODO: force close seems not working properly (when fixed, we should await for it)
      server.close(true).catch(() => {});
      process.exit(0);
    };
    // Handle Ctrl+C
    process.on("SIGINT", () => {
      console.log(c.gray("\r  \nStopping server..."));
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
  _dev: boolean;
  _command: string;
  _entry: string;
  _static: string;
  _help?: boolean;
  _version?: boolean;
};

async function loadEntry(opts: CLIOptions): Promise<ServerOptions> {
  try {
    // Guess entry if not provided
    if (!opts._entry || extname(opts._entry) === "") {
      const baseDir = resolve(opts._entry || ".");
      let foundEntry: string | undefined;
      // prettier-ignore
      const defaultEntries = ["server", "src/server", "app","src/app", "index", "src/index"];
      const defaultExts = [".mts", ".ts", ".cts", ".js", ".mjs", ".cjs"];
      for (const entry of defaultEntries) {
        for (const ext of defaultExts) {
          const entryPath = resolve(baseDir, `${entry}${ext}`);
          if (existsSync(entryPath)) {
            foundEntry = entryPath;
            break;
          }
        }
        if (foundEntry) break;
      }
      if (!foundEntry) {
        throw `No entry file found in ${c.cyan(baseDir)}.\nPlease specify an entry file or ensure one of the default entries exists in the directory (${defaultEntries.map((e) => c.cyan(e)).join(", ")}).`;
      }
      opts._entry = foundEntry;
    }

    // Convert to file:// URL for consistent imports
    const entryURL = opts._entry.startsWith("file://")
      ? opts._entry
      : pathToFileURL(resolve(opts._entry)).href;

    // Import the user file
    const entryModule = await import(entryURL);
    const defaultExport = entryModule.default;
    if (defaultExport) {
      // If default export is a function, treat it as fetch handler
      if (typeof defaultExport === "function") {
        return { ...opts, fetch: defaultExport };
      }
      // If default export is an object, parse it
      if (typeof defaultExport?.fetch === "function") {
        return { ...defaultExport, ...opts, fetch: defaultExport.fetch };
      }
    }
    throw `Default export must be an object with a ${c.cyan("fetch")} function.\n\n${c.bold("Example:")}\n\n${example()}\n`;
  } catch (error) {
    console.error(c.red(`${c.bold(opts._entry)}`));
    if (error instanceof Error) {
      Error.captureStackTrace?.(error, serve);
    }
    throw error;
  }
}

function renderError(error: unknown, dev?: boolean): string {
  let html = `<!DOCTYPE html><html><head><title>Server Error</title></head><body>`;
  if (dev) {
    html += /* html */ `
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f8f9fa; color: #333; }
      h1 { color: #dc3545; }
      pre { background: #fff; padding: 10px; border-radius: 5px; overflow: auto; }
      code { font-family: monospace; }
      #error { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 70vh; }
    </style>
    <div id="error"><h1>Server Error</h1><pre>${error instanceof Error ? error.stack || error.message : String(error)}</pre></div>
    `;
  } else {
    html += `<h1>Server Error</h1><p>Something went wrong while processing your request.</p>`;
  }

  return html;
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
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      static: { type: "string", short: "s" },
      tls: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });

  return {
    _dev: positionals[0] === "dev",
    _command: positionals[0] || "",
    _entry: positionals[1] || "",
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
  return `${c.magenta("export default ")} {
  ${c.gray("// https://srvx.h3.dev/guide/options")}
  ${c.cyan("port")}: ${c.yellow("3000")},
  ${c.cyan("fetch")}(request${useTs ? ": Request" : ""}) {
    ${c.magenta("return")} new Response(${c.green('"Hello, World!"')});
  }
}`;
}

function help(mainOpts: MainOpts): string {
  const command = mainOpts.command;
  return `
${c.cyan(command)} - Start an HTTP server with the specified entry file.

${c.bold("USAGE")}

${c.bold(c.gray("// server.ts"))}
${example()}

${c.gray("# srvx dev|start [options] [<entry>]")}
${c.gray("$")} ${c.cyan(command)} ${c.magenta("dev")} ./server.ts                    ${c.gray("# Start server with default options")}
${c.gray("$")} ${c.cyan(command)} ${c.magenta("dev")} --port=8080 ./server.ts        ${c.gray("# Start server on port 8080")}
${c.gray("$")} ${c.cyan(command)} ${c.magenta("dev")} --host=localhost ./server.ts   ${c.gray("# Bind to localhost only")}
${c.gray("$")} ${c.cyan(command)} ${c.magenta("dev")} --tls --cert=cert.pem --key=key.pem ./server.ts  ${c.gray("# HTTP2 server with TLS")}

${c.bold("ARGUMENTS")}

  ${c.yellow("<entry>")}                  Server entry to serve

${c.bold("OPTIONS")}

  ${c.green("-p, --port")} ${c.yellow("<port>")}        Port to listen on (default: ${c.yellow("3000")})
  ${c.green("-H, --host")} ${c.yellow("<host>")}        Host to bind to (default: all interfaces)
  ${c.green("-s, --static")} ${c.yellow("<dir>")}       Serve static files from the specified directory (default: ${c.yellow("public")})
      ${c.green("--tls")}                Enable TLS (HTTPS/HTTP2)
      ${c.green("--cert")} ${c.yellow("<file>")}        TLS certificate file
      ${c.green("--key")}  ${c.yellow("<file>")}        TLS private key file
  ${c.green("-h, --help")}               Show this help message
  ${c.green("-v, --version")}            Show server and runtime versions

${c.bold("ENVIRONMENT")}

  ${c.green("PORT")}                     Override port
  ${c.green("HOST")}                     Override host

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
