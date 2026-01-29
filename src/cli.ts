import type { Server, ServerMiddleware, ServerOptions } from "srvx";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, extname, relative, resolve } from "node:path";
import { fork } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import * as c from "./_color.ts";
import { loadServerEntry, type LoadOptions } from "./loader.ts";
import pkg from "../package.json" with { type: "json" };

// prettier-ignore
const defaultEntries = ["server", "index", "src/server", "src/index", "server/index"];
// prettier-ignore
const defaultExts = [".mts", ".ts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".tsx"];

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
    console.log(version());
    process.exit(0);
  }
  // Handle help flag
  if (options._help) {
    console.log(usage(mainOpts));
    process.exit(options._help ? 0 : 1);
  }

  // Fetch mode
  if (options._mode === "fetch") {
    try {
      await cliFetch({
        url: options._url,
        entry: options._entry,
        dir: options._dir,
        method: options._method,
        headers: options._headers,
        data: options._data,
        verbose: options._verbose,
        hostname: options.hostname,
      });
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }

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
      ...[".env", options._prod ? ".env.production" : ".env.local"]
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

  // Ensure child process is killed on exit
  let cleanupCalled = false;
  const cleanup = (signal: any, exitCode?: number) => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    try {
      child.kill(signal || "SIGTERM");
    } catch (error) {
      console.error("Error killing child process:", error);
    }
    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  };
  process.on("exit", () => cleanup("SIGTERM"));
  process.on("SIGINT" /* ctrl+c */, () => cleanup("SIGINT", 130));
  process.on("SIGTERM", () => cleanup("SIGTERM", 143));
}

async function serve() {
  try {
    // Set default NODE_ENV
    if (!process.env.NODE_ENV) {
      process.env.NODE_ENV = options._prod ? "production" : "development";
    }

    // Load server entry file and create a new server instance
    const loaded = await loadServerEntry({
      entry: options._entry,
      dir: options._dir,
    });

    const { serve: srvxServe } = loaded.nodeCompat
      ? await import("srvx/node")
      : await import("srvx");
    const { serveStatic } = await import("srvx/static");
    const { log } = await import("srvx/log");

    const staticDir = resolve(options._dir, options._static);
    options._static = existsSync(staticDir) ? staticDir : "";

    const serverOptions = {
      ...loaded.module?.default,
      default: undefined,
      ...loaded.module,
    } as Partial<ServerOptions>;

    const server = srvxServe({
      gracefulShutdown: options._prod,
      ...serverOptions,
      ...options,
      error: (error) => {
        console.error(error);
        return renderError(error);
      },
      fetch:
        loaded.fetch ||
        (() =>
          renderError(
            loaded.notFound ? "Server Entry Not Found" : "No Fetch Handler Exported",
            501,
          )),
      middleware: [
        log(),
        options._static
          ? serveStatic({
              dir: options._static,
            })
          : undefined,
        ...(serverOptions.middleware || []),
      ].filter(Boolean) as ServerMiddleware[],
    });

    globalThis.__srvx__ = server;
    await server.ready();

    printInfo(options, loaded);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

declare global {
  var __srvx__: Server;
}

type MainOpts = {
  command: string;
  docs: string;
  issues: string;
};

type CLIOptions = Partial<ServerOptions> & {
  _mode: "serve" | "fetch";
  _entry: string;
  _dir: string;
  _prod: boolean;
  _static: string;
  _help?: boolean;
  _version?: boolean;
  _import?: string;
  _method?: string;
  _headers?: string[];
  _url?: string;
  _verbose?: boolean;
  _data?: string;
};

function renderError(error: unknown, status = 500, title = "Server Error"): Response {
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

function printInfo(options: CLIOptions, loaded: Awaited<ReturnType<typeof loadServerEntry>>) {
  let entryInfo: string;
  if (loaded.notFound) {
    entryInfo = c.gray(`(create ${c.bold(`server.ts`)} to enable)`);
  } else {
    entryInfo = loaded.fetch
      ? c.cyan("./" + relative(".", fileURLToPath(loaded.url!)))
      : c.red(`No fetch handler exported from ${loaded.url || resolve(options._entry)}`);
  }
  console.log(c.gray(`${c.bold(c.gray("λ"))} Server handler: ${entryInfo}`));
  let staticInfo: string;
  if (options._static) {
    staticInfo = c.cyan("./" + relative(".", options._static) + "/");
  } else {
    staticInfo = c.gray(`(add ${c.bold("public/")} dir to enable)`);
  }
  console.log(c.gray(`${c.bold(c.gray("∘"))} Static files:   ${staticInfo}`));
}

function version() {
  return `srvx ${pkg.version}\n${runtime()}`;
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
  const pArg0 = args.find((a) => !a.startsWith("-"));
  const mode = pArg0 === "fetch" ? "fetch" : "serve";

  if (mode === "fetch") {
    const { values, positionals } = parseNodeArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        version: { type: "boolean" },
        prod: { type: "boolean" },
        dir: { type: "string" },
        host: { type: "string", short: "H" },
        entry: { type: "string" },
        request: { type: "string", short: "X" },
        header: { type: "string", multiple: true, short: "H" },
        verbose: { type: "boolean", short: "v" },
        data: { type: "string", short: "d" },
      },
    });

    return {
      _mode: "fetch",
      _help: values.help,
      _version: values.version,
      _method: values.request,
      _headers: values.header,
      _url: positionals[0] || "/",
      _verbose: values.verbose,
      _entry: values.entry || "",
      _static: "public",
      _dir: values.dir ? resolve(values.dir) : process.cwd(),
      _prod: process.env.NODE_ENV === "production",
      hostname: values.host || "cli",
      _data: values.data,
    };
  }

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
  if (!existsSync(dir)) {
    console.error(c.red(`Directory "${dir}" does not exist.\n`));
    process.exit(1);
  }

  return {
    _mode: "serve",
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

export async function cliFetch(
  options: LoadOptions & {
    url?: string;
    method?: string;
    headers?: string[];
    data?: string;
    verbose?: boolean;
    hostname?: string;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
  },
): Promise<Response> {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const loaded = await loadServerEntry(options);

  if (loaded.notFound) {
    throw new Error("Server entry file not found.", {
      cause: {
        dir: options.dir || process.cwd(),
        entry: options.entry || undefined,
      },
    });
  }

  if (!loaded.fetch) {
    throw new Error("No fetch handler exported", {
      cause: {
        dir: options.dir || process.cwd(),
        entry: options.entry || undefined,
        loaded,
      },
    });
  }

  // Build request URL
  const url = new URL(options.url || "/", `http://${options.hostname || "cli"}`).toString();

  // Build Headers
  const headers = new Headers();
  if (options.headers) {
    for (const header of options.headers) {
      const colonIndex = header.indexOf(":");
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).trim();
        const value = header.slice(colonIndex + 1).trim();
        headers.append(name, value);
      }
    }
  }

  // Build body
  let body: BodyInit | undefined;
  if (options.data !== undefined) {
    if (options.data === "@-") {
      // Read from stdin
      body = new ReadableStream({
        async start(controller) {
          for await (const chunk of stdin) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    } else if (options.data.startsWith("@")) {
      // Read from file as stream
      body = Readable.toWeb(createReadStream(options.data.slice(1))) as unknown as ReadableStream;
    } else {
      body = options.data;
    }
  }

  const method = options.method || (body === undefined ? "GET" : "POST");

  // Build request
  const req = new Request(url, {
    method,
    headers,
    body,
  });

  // Verbose: print request info
  if (options.verbose) {
    const parsedUrl = new URL(url);
    stderr.write(`> ${method} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\n`);
    stderr.write(`> Host: ${parsedUrl.host}\n`);
    for (const [name, value] of headers) {
      stderr.write(`> ${name}: ${value}\n`);
    }
    stderr.write(">\n");
  }

  const res = await loaded.fetch(req);

  // Verbose: print response info
  if (options.verbose) {
    stderr.write(`< HTTP/1.1 ${res.status} ${res.statusText}\n`);
    for (const [name, value] of res.headers) {
      stderr.write(`< ${name}: ${value}\n`);
    }
    stderr.write("<\n");
  }

  // Stream response to stdout
  if (res.body) {
    const { isBinary, encoding } = getResponseFormat(res);

    if (isBinary) {
      // Stream binary directly to stdout
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        stdout.write(chunk);
      }
    } else {
      // Stream text with proper encoding
      const decoder = new TextDecoder(encoding);
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        stdout.write(decoder.decode(chunk, { stream: true }));
      }
      // Flush any remaining bytes
      const remaining = decoder.decode();
      if (remaining) {
        stdout.write(remaining);
      }
      // Add trailing newline for text content when interactive
      // (avoid changing byte-for-byte output in scripts/pipes)
      if (stdout.isTTY) {
        stdout.write("\n");
      }
    }
  }

  if (!res.ok) {
    const err = new Error(`Request failed with status ${res.status} ${res.statusText}`);
    Error.captureStackTrace?.(err, cliFetch);
    throw err;
  }

  return res;
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

${c.bold("FETCH MODE")}

${c.gray("# srvx fetch [options] [url]")}
${c.gray("$")} ${c.cyan(command)} fetch                  ${c.gray("# Fetch from default entry")}
${c.gray("$")} ${c.cyan(command)} fetch /api/users       ${c.gray("# Fetch a specific URL/path")}
${c.gray("$")} ${c.cyan(command)} fetch --entry ./server.ts /api/users ${c.gray("# Fetch using a specific entry")}
${c.gray("$")} ${c.cyan(command)} fetch -X POST /api/users ${c.gray("# POST request")}
${c.gray("$")} ${c.cyan(command)} fetch -H "Content-Type: application/json" /api ${c.gray("# With headers")}
${c.gray("$")} ${c.cyan(command)} fetch -d '{"name":"foo"}' /api ${c.gray("# With request body")}
${c.gray("$")} echo '{"name":"foo"}' | ${c.cyan(command)} fetch -d @- /api ${c.gray("# Body from stdin")}
${c.gray("$")} ${c.cyan(command)} fetch -v /api/users    ${c.gray("# Verbose output (show headers)")}

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
  ${c.green("--version")}                Show server and runtime versions

${c.bold("FETCH OPTIONS")}

  ${c.green("-X, --request")} ${c.yellow("<method>")}   HTTP method (default: ${c.yellow("GET")}, or ${c.yellow("POST")} if body is provided)
  ${c.green("-H, --header")} ${c.yellow("<header>")}    Add header (format: "Name: Value", can be used multiple times)
  ${c.green("-d, --data")} ${c.yellow("<data>")}        Request body (use ${c.yellow("@-")} for stdin, ${c.yellow("@file")} for file)
  ${c.green("-v, --verbose")}            Show request and response headers

${c.bold("ENVIRONMENT")}

  ${c.green("PORT")}                     Override port
  ${c.green("HOST")}                     Override host
  ${c.green("NODE_ENV")}                 Set to ${c.yellow("production")} for production mode.

➤ ${c.url("Documentation", mainOpts.docs || "https://srvx.h3.dev")}
➤ ${c.url("Report issues", mainOpts.issues || "https://github.com/h3js/srvx/issues")}
`.trim();
}

function getResponseFormat(res: Response): {
  isBinary: boolean;
  encoding: string;
} {
  const contentType = res.headers.get("content-type") || "";
  const isBinary =
    contentType.startsWith("application/octet-stream") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("application/zip") ||
    contentType.startsWith("application/gzip");
  const encoding = contentType.includes("charset=")
    ? contentType.split("charset=")[1].split(";")[0].trim()
    : "utf8";
  return { isBinary, encoding };
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
