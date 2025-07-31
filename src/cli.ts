#!/usr/bin/env node

import type { ServerOptions } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fork } from "node:child_process";

// Colors support for terminal output
const _c = (c: number) => (t: string) => `\u001B[${c}m${t}\u001B[0m`;
const c = {
  bold: _c(1),
  green: _c(32),
  yellow: _c(33),
  magenta: _c(35),
  cyan: _c(36),
  gray: _c(90),
  url: (title: string, url: string) =>
    `\u001B]8;;${url}\u001B\\${title}\u001B]8;;\u001B\\`,
} as const;

setupProcessErrorHandlers();

const args = process.argv.slice(2);
const options = parseArgs(args);

if (process.send) {
  await serve(); // Forked process
} else {
  await main({
    command: "srvx",
    docs: "https://srvx.h3.dev",
    issues: "https://github.com/h3js/srvx/issues",
  });
}

export async function main(mainOpts: MainOpts): Promise<void> {
  // Handle version flag
  if (options._version) {
    console.log(await version());
    process.exit(0);
  }
  // Handle help flag
  if (options._help || !options._entry) {
    console.log(help(mainOpts));
    process.exit(options._help ? 0 : 1);
  }
  // Fork a child process to run the server
  console.log(
    c.gray(`${c.cyan(options._entry)} ${c.gray("(watching for changes)")}`),
  );
  const child = fork(fileURLToPath(import.meta.url), args, {
    execArgv: [
      ...process.execArgv,
      "--watch",
      options._entry.endsWith(".ts") ? "--experimental-strip-types" : "",
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
}

async function serve() {
  try {
    // Load server entry file and create a new server instance
    const { serve } = await import("srvx");
    const server = await serve(await loadEntry(options)).ready();

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
  _entry: string;
  _help?: boolean;
  _version?: boolean;
};

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
      tls: { type: "boolean" },
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
    tls: values.tls ? { cert: values.cert, key: values.key } : undefined,
  };
}

function help(mainOpts: MainOpts): string {
  const command = mainOpts.command;
  return `
${c.cyan(command)} - Start an HTTP server with the specified entry file

${c.bold("USAGE")}

${c.bold(c.gray("// server.ts"))}
${c.magenta("export default ")} {
  ${c.cyan("port")}: ${c.yellow("3000")},
  ${c.cyan("fetch")}(request: Request) {
    ${c.magenta("return")} new Response(${c.green('"Hello, World!"')});
  }
}

${c.gray("$")} ${c.cyan(command)} ${c.gray("[options]")} ${c.yellow("<entry>")}
${c.gray("$")} ${c.cyan(command)} server.ts                    ${c.gray("# Start server with default options")}
${c.gray("$")} ${c.cyan(command)} --port=8080 server.ts        ${c.gray("# Start server on port 8080")}
${c.gray("$")} ${c.cyan(command)} --host=localhost server.ts   ${c.gray("# Bind to localhost only")}
${c.gray("$")} ${c.cyan(command)} --tls --cert=cert.pem --key=key.pem server.ts  ${c.gray("# HTTP2 server with TLS")}

${c.bold("ARGUMENTS")}

  ${c.yellow("<entry>")}                  Server entry to serve

${c.bold("OPTIONS")}

  ${c.green("-p, --port")} ${c.yellow("<port>")}        Port to listen on (default: ${c.yellow("3000")})
  ${c.green("-H, --host")} ${c.yellow("<host>")}        Host to bind to (default: all interfaces)
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
