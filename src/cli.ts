#!/usr/bin/env node

import type { ServerOptions } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

setupProcessErrorHandlers();
main();

async function main() {
  try {
    // Parse command line arguments (skip executable and script name)
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    // Handle version flag
    if (options._version) {
      console.log(await version());
      process.exit(0);
    }

    // Handle help flag
    if (options._help || !options._entry) {
      console.log(help());
      process.exit(options._help ? 0 : 1);
    }

    // Load server entry file and create a new server instance
    const { serve } = await import("srvx");
    const server = await serve(await loadEntry(options)).ready();

    // Keep the process alive with proper cleanup
    const cleanup = async () => {
      console.log("\nShutting down server...");
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

// ---- internals ----

type CLIOptions = Partial<ServerOptions> & {
  _entry: string;
  _help?: boolean;
  _version?: boolean;
};

/**
 * Parse command line arguments using Node.js util.parseArgs
 */
function parseArgs(args: string[]): CLIOptions {
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      https: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
    },
  });

  return {
    _entry: positionals[0] || "",
    _help: values.help,
    _version: values.version,
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    hostname: values.host,
    tls: values.https ? { cert: values.cert, key: values.key } : undefined,
  };
}

async function loadEntry(opts: CLIOptions): Promise<ServerOptions> {
  try {
    // Convert to file:// URL for consistent imports
    const entryURL = opts._entry.startsWith("file://")
      ? opts._entry
      : pathToFileURL(resolve(opts._entry)).href;

    // Import the user file
    const userModule = await import(entryURL);
    const defaultExport = userModule.default;

    if (!defaultExport) {
      throw new TypeError("File must have a default export");
    }

    // If default export is a function, treat it as fetch handler
    if (typeof defaultExport === "function") {
      return { ...opts, fetch: defaultExport };
    }

    // If default export is an object, parse it
    if (typeof defaultExport?.fetch === "function") {
      return { ...defaultExport, ...opts, fetch: defaultExport.fetch };
    }

    throw new TypeError(
      "Default export must be a function or an object with a 'fetch' function",
    );
  } catch (error) {
    throw new Error(
      `Failed to load file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function version() {
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  return `srvx v${pkg.version}`;
}

function help(): string {
  const c = (code: number) => (text: string) =>
    `\u001B[${code}m${text}\u001B[0m`;
  const cyan = c(36);
  const yellow = c(33);
  const green = c(32);
  const bold = c(1);
  const magenta = c(35);
  const gray = c(90);
  return `
${bold(cyan("Usage:"))} srvx [options] ${yellow("<entry>")}

Start an HTTP server with the specified entry file.

${bold("Arguments:")}
  ${yellow("<entry>")}                  Server entry to serve

${bold("Options:")}
  ${green("-p, --port")} ${yellow("<port>")}        Port to listen on (default: ${yellow("3000")})
  ${green("-H, --host")} ${yellow("<host>")}        Host to bind to (default: all interfaces)
      ${green("--https")}              Enable HTTPS
      ${green("--cert")} ${yellow("<file>")}        TLS certificate file
      ${green("--key")}  ${yellow("<file>")}        TLS private key file
  ${green("-h, --help")}               Show this help message
  ${green("-v, --version")}            Show version number

${bold("Examples:")}
  srvx server.mjs                    ${gray("# Start server with default options")}
  srvx --port=8080 server.mjs        ${gray("# Start server on port 8080")}
  srvx --host=localhost server.mjs   ${gray("# Bind to localhost only")}
  srvx --https --cert=cert.pem --key=key.pem server.mjs  ${gray("# HTTPS server")}

The entry file should export a default object with a ${cyan("fetch")} method:

${magenta("export default ")} {
  ${cyan("port")}: ${yellow("3000")},
  ${cyan("fetch")}(request) {
    ${magenta("return")} new Response(${green('"Hello, World!"')});
  }
}

➤ Documentation: ${cyan("https://srvx.h3.dev")}
➤ Report issues: ${cyan("https://github.com/h3js/srvx/issues")}
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
