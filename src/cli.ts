#!/bin/sh
//bin/true; (command -v bun && bun $0 $@) || (command -v deno && deno -A $0 $@)|| (command -v node && node $0 $@) || exit 1

/**
 * srvx CLI - Universal HTTP server command line interface
 */

import { serve } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import packageMetadata from "../package.json" with { type: "json" };

export interface CLIOptions {
  /** The file to serve */
  file: string;
  /** Server port */
  port?: number;
  /** Server hostname */
  host?: string;
  /** Enable HTTPS */
  https?: boolean;
  /** TLS certificate file path */
  cert?: string;
  /** TLS private key file path */
  key?: string;
  /** Show help */
  help?: boolean;
  /** Show version */
  version?: boolean;
}

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
    file: positionals[0] || "",
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    host: values.host,
    https: values.https,
    cert: values.cert,
    key: values.key,
    help: values.help,
    version: values.version,
  };
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

/**
 * Validate parsed options
 */
function validateOptions(options: CLIOptions): string[] {
  const errors: string[] = [];

  if (!options.file && !options.help && !options.version) {
    errors.push("No input file specified");
  }

  if (options.port && (options.port < 1 || options.port > 65_535)) {
    errors.push("Port must be between 1 and 65535");
  }

  if (options.https && (!options.cert || !options.key)) {
    errors.push("HTTPS requires both --cert and --key options");
  }

  return errors;
}

/**
 * Load and parse user configuration file
 */
async function loadUserFile(filePath: string, cliOptions: CLIOptions) {
  try {
    // Convert to file:// URL for consistent imports
    const fileUrl = filePath.startsWith("/")
      ? `file://${filePath}`
      : filePath.startsWith("file://")
      ? filePath
      : `file://${process.cwd()}/${filePath}`;

    // Import the user file
    const userModule = await import(fileUrl);
    const defaultExport = userModule.default;

    if (!defaultExport) {
      throw new TypeError("File must have a default export");
    }

    // If default export is a function, treat it as fetch handler
    if (typeof defaultExport === "function") {
      return createServerOptions({ fetch: defaultExport }, cliOptions);
    }

    // If default export is an object, parse it
    if (typeof defaultExport === "object" && defaultExport !== null) {
      if (typeof defaultExport.fetch !== "function") {
        throw new TypeError("Default export must have a 'fetch' function");
      }

      return createServerOptions(defaultExport, cliOptions);
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
 * Create ServerOptions by merging user config with CLI options
 */
function createServerOptions(userConfig: any, cliOptions: CLIOptions) {
  const serverOptions: any = {
    fetch: userConfig.fetch,
  };

  // Merge user configuration (only basic options)
  if (userConfig.port !== undefined) serverOptions.port = userConfig.port;
  if (userConfig.hostname !== undefined) {
    serverOptions.hostname = userConfig.hostname;
  }
  if (userConfig.host !== undefined) serverOptions.hostname = userConfig.host; // alias

  // Override with CLI options (CLI takes precedence)
  if (cliOptions.port !== undefined) serverOptions.port = cliOptions.port;
  if (cliOptions.host !== undefined) serverOptions.hostname = cliOptions.host;

  // Handle TLS options
  if (cliOptions.https || cliOptions.cert || cliOptions.key) {
    serverOptions.protocol = "https";
    if (!serverOptions.tls) serverOptions.tls = {};
    if (cliOptions.cert) serverOptions.tls.cert = cliOptions.cert;
    if (cliOptions.key) serverOptions.tls.key = cliOptions.key;
  }

  return serverOptions;
}

/**
 * Get package version
 */
function getVersion(): string {
  return packageMetadata.version || "unknown";
}

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  try {
    // Parse command line arguments (skip node executable and script name)
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    // Handle help flag
    if (options.help) {
      console.log(showHelp());
      process.exit(0);
    }

    // Handle version flag
    if (options.version) {
      const version = getVersion();
      console.log(`srvx v${version}`);
      process.exit(0);
    }

    // Validate options
    const errors = validateOptions(options);
    if (errors.length > 0) {
      console.error("Error: " + errors.join(", "));
      console.error("\nUse --help for usage information.");
      process.exit(1);
    }

    // Load user configuration file
    const serverOptions = await loadUserFile(options.file, options);

    // Create and start the server using the unified srvx import
    const server = serve(serverOptions);

    // Wait for server to be ready
    await server.ready();

    // Keep the process alive with proper cleanup
    const cleanup = async () => {
      console.log("\nShutting down server...");
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (error) {
    console.error(
      "Fatal error:",
      error instanceof Error ? error.message : String(error),
    );

    // Show stack trace in development mode
    if (process.env.NODE_ENV === "development" || process.env.DEBUG) {
      console.error(error);
    }

    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Run the CLI if this file is being executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
