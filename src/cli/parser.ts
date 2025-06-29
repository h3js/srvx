/**
 * Command line argument parser for srvx CLI
 */

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
  /** Enable development mode (watch mode in future) */
  dev?: boolean;
  /** Show help */
  help?: boolean;
  /** Show version */
  version?: boolean;
  /** Runtime to use (auto-detected if not specified) */
  runtime?: "node" | "deno" | "bun";
}

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = {
    file: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // eslint-disable-next-line unicorn/prefer-switch
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--dev" || arg === "-d") {
      options.dev = true;
    } else if (arg === "--https") {
      options.https = true;
    } else if (arg.startsWith("--port=")) {
      const port = Number.parseInt(arg.split("=")[1], 10);
      if (!Number.isNaN(port)) options.port = port;
    } else if (arg === "--port" || arg === "-p") {
      const port = Number.parseInt(args[++i], 10);
      if (!Number.isNaN(port)) options.port = port;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.split("=")[1];
    } else if (arg === "--host" || arg === "-H") {
      options.host = args[++i];
    } else if (arg.startsWith("--cert=")) {
      options.cert = arg.split("=")[1];
    } else if (arg === "--cert") {
      options.cert = args[++i];
    } else if (arg.startsWith("--key=")) {
      options.key = arg.split("=")[1];
    } else if (arg === "--key") {
      options.key = args[++i];
    } else if (arg.startsWith("--runtime=")) {
      const runtime = arg.split("=")[1] as CLIOptions["runtime"];
      if (["node", "deno", "bun"].includes(runtime!)) {
        options.runtime = runtime;
      }
    } else if (arg === "--runtime") {
      const runtime = args[++i] as CLIOptions["runtime"];
      if (["node", "deno", "bun"].includes(runtime!)) {
        options.runtime = runtime;
      }
    } else if (!arg.startsWith("-") && !options.file) {
      // First non-flag argument is the file
      options.file = arg;
    }
  }

  return options;
}

/**
 * Display help message
 */
export function showHelp(): string {
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
      --runtime <runtime>  Runtime to use (node|deno|bun, auto-detected)
  -d, --dev                Enable development mode
  -h, --help               Show this help message
  -v, --version            Show version number

Examples:
  srvx server.js                    # Start server with default settings
  srvx --port=8080 server.js        # Start server on port 8080
  srvx --host=localhost server.js   # Bind to localhost only
  srvx --https --cert=cert.pem --key=key.pem server.js  # HTTPS server

Supported file formats:
  - JavaScript (.js, .mjs)
  - TypeScript (.ts) - if runtime supports it

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
export function validateOptions(options: CLIOptions): string[] {
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
