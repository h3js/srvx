import type { Server } from "srvx";

declare global {
  var __srvx__: Server | undefined;
}

export type MainOptions = CLIOptions & {
  args?: string[];
  usage?: {
    command?: string;
    docs?: string;
    issues?: string;
  };
};

/**
 * CLI options for srvx command
 */
export type CLIOptions = {
  // --- Common flags ---

  /** CLI mode: "serve" to start a server, "fetch" to make HTTP requests */
  mode?: "serve" | "fetch";
  /** Show help message */
  help?: boolean;
  /** Show server and runtime versions */
  version?: boolean;
  /** Working directory for resolving entry file */
  dir?: string;
  /** Server entry file to use */
  entry?: string;

  // --- Serve mode ---

  /** Run in production mode (no watch, no debug) */
  prod?: boolean;
  /** Serve static files from the specified directory (default: "public") */
  static?: string;
  /** ES module to preload */
  import?: string;
  /** Host to bind to (default: all interfaces) */
  host?: string;
  /** Port to listen on (default: "3000") */
  port?: string;
  /** Enable TLS (HTTPS/HTTP2) */
  tls?: boolean;
  /** TLS certificate file */
  cert?: string;
  /** TLS private key file */
  key?: string;

  // --- Fetch mode ---

  /** URL or path to fetch */
  url?: string;
  /** HTTP method (default: "GET", or "POST" if body is provided) */
  method?: string;
  /** Request headers (format: "Name: Value", can be used multiple times) */
  header?: string[];
  /** Show request and response headers */
  verbose?: boolean;
  /** Request body (use "@-" for stdin, "@file" for file) */
  data?: string;
};
