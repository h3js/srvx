#!/usr/bin/env node

import { serve, type ServerOptions } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import packageMetadata from "../package.json" with { type: "json" };
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

try {
  // Parse command line arguments (skip executable and script name)
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  // Handle help flag
  if (options._help) {
    console.log(showHelp());
    process.exit(0);
  }

  // Handle version flag
  if (options._version) {
    console.log(`srvx v${packageMetadata.version}`);
    process.exit(0);
  }

  // Load server entry file and create a new server instance
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
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      https: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
    },
    allowPositionals: true,
  });

  return {
    ...values,
    _entry: positionals[0] || "",
    _help: values.help,
    _version: values.version,
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    hostname: values.host,
    tls: values.https ? { cert: values.cert, key: values.key } : undefined,
  };
}

/**
 * Load server entry file
 */
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

/**
 * Display help message
 */
function showHelp(): string {
  return `
Usage: srvx [options] <file>

Start an HTTP server with the specified handler file.

Arguments:
  <file>                   The JavaScript/TypeScript file to serve

Options:
  -p, --port <port>        Port to listen on (default: 3000)
  -H, --host <host>        Host to bind to (default: all interfaces)
      --https              Enable HTTPS
      --cert <file>        TLS certificate file
      --key <file>         TLS private key file
  -h, --help               Show this help message
  -v, --version            Show version number

Examples:
  srvx server.js                    # Start server with default settings
  srvx --port=8080 server.js        # Start server on port 8080
  srvx --host=localhost server.js   # Bind to localhost only
  srvx --https --cert=cert.pem --key=key.pem server.js  # HTTPS server

The handler file should export a default object with a 'fetch' function:

  export default {
    fetch(request) {
      return new Response("Hello from srvx!");
    }
  }

Or with additional configuration:

  export default {
    port: 3000,
    host: 'localhost',
    fetch(request) {
      return new Response("Configured server!");
    }
  }
`.trim();
}
