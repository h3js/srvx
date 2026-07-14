import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as c from "./_utils.ts";
import type { CLIOptions, MainOptions } from "./types.ts";
import { cliServe, NO_ENTRY_ERROR } from "./serve.ts";
import { cliFetch } from "./fetch.ts";
import { usage } from "./usage.ts";
import { srvxMeta } from "./_meta.ts";

export async function main(mainOpts: MainOptions): Promise<void> {
  // F60: honor an explicit `args` array (used by tests); fall back to process.argv
  const args = mainOpts.args ?? process.argv.slice(2);

  let cliOpts: CLIOptions;
  try {
    cliOpts = parseArgs(args);
  } catch (error) {
    // F44: surface parse/entry-resolution problems as a one-line message + hint
    const command = mainOpts.usage?.command || "srvx";
    console.error(c.red((error as Error).message || String(error)));
    console.error(c.gray(`Run \`${command} --help\` for usage.`));
    process.exit(1);
  }

  // Handle version flag
  if (cliOpts.version) {
    process.stdout.write(versions(mainOpts).join("\n") + "\n");
    process.exit(0);
  }

  // Handle help flag
  if (cliOpts.help) {
    console.log(usage(mainOpts));
    process.exit(0);
  }

  // Resolve .env files (used by both serve and fetch modes)
  const envFiles = [".env", cliOpts.prod ? ".env.production" : ".env.local"].filter((f) =>
    existsSync(f),
  );

  // Fetch mode
  if (cliOpts.mode === "fetch") {
    // F44: load env before fetching (the entry/handler may rely on env vars)
    for (const envFile of [...envFiles].reverse() /* overrides first */) {
      process.loadEnvFile?.(envFile);
    }
    try {
      const res = await cliFetch(cliOpts);
      process.exit(res.ok ? 0 : 22);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }

  // Running in a child process
  if (process.send) {
    return startServer(cliOpts);
  }

  // Log versions
  console.log(c.gray([...versions(mainOpts), cliOpts.prod ? "prod" : "dev"].join(" · ")));

  if (envFiles.length > 0) {
    console.log(
      `${c.gray(`Loading environment variables from ${c.magenta(envFiles.join(", "))}`)}`,
    );
  }

  // In prod mode without --import, run directly in current process (no fork needed)
  if (cliOpts.prod && !cliOpts.import) {
    // Load env files manually since we're not forking with --env-file args
    for (const envFile of [...envFiles].reverse() /* overrides first */) {
      process.loadEnvFile?.(envFile);
    }
    await startServer(cliOpts);
    return;
  }

  // Fork a child process with additional args
  const isBun = !!process.versions.bun;
  const isDeno = !!process.versions.deno;
  const isNode = !isBun && !isDeno;
  const runtimeArgs: string[] = [];
  runtimeArgs.push(...envFiles.map((f) => `--env-file=${f}`));
  if (!cliOpts.prod) {
    runtimeArgs.push("--watch");
  }
  if (cliOpts.import && (isNode || isBun)) {
    runtimeArgs.push(`--import=${cliOpts.import}`);
  }

  await forkCLI(args, runtimeArgs);
}

function parseArgs(args: string[]): CLIOptions {
  // Parse with a combined schema so option VALUES are never mistaken for the
  // subcommand (F40). serve/fetch short flags don't collide, so one pass is safe.
  const options = {
    // --- Common flags ---
    help: { type: "boolean", short: "h" }, // F41: -h is documented in usage
    version: { type: "boolean" },
    dir: { type: "string" },
    entry: { type: "string" },
    host: { type: "string" },
    hostname: { type: "string" },
    tls: { type: "boolean" },
    url: { type: "string" },
    // --- Serve mode ---
    prod: { type: "boolean" },
    port: { type: "string", short: "p" },
    static: { type: "string", short: "s" },
    import: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    // --- Fetch mode ---
    method: { type: "string", short: "X" },
    request: { type: "string" }, // curl compatibility
    header: { type: "string", multiple: true, short: "H" },
    verbose: { type: "boolean", short: "v" },
    data: { type: "string", short: "d" },
  } as const;

  const { values, positionals } = parseNodeArgs({ args, allowPositionals: true, options });

  // Detect mode from the first real positional (the subcommand), then drop it.
  let mode: "serve" | "fetch" = "serve";
  const sub = positionals[0];
  if (sub === "fetch" || sub === "curl") {
    mode = "fetch";
    positionals.shift();
  } else if (sub === "serve") {
    positionals.shift();
  }

  if (mode === "fetch") {
    const method = values.method || values.request;
    const url = values.url || positionals[0] || "/";
    return { mode, ...values, url, method };
  }

  // Serve mode: allow entry or dir as a positional argument
  const maybeEntryOrDir = positionals[0];
  if (maybeEntryOrDir) {
    if (values.entry || values.dir) {
      throw new Error("Cannot use a positional path together with --entry or --dir.");
    }
    // F44: turn a raw statSync ENOENT into a friendly message
    if (!existsSync(maybeEntryOrDir)) {
      throw new Error(`No such file or directory: ${maybeEntryOrDir}`);
    }
    if (statSync(maybeEntryOrDir).isDirectory()) {
      values.dir = maybeEntryOrDir;
    } else {
      values.entry = maybeEntryOrDir;
    }
  }

  return { mode, ...values };
}

async function startServer(cliOpts: CLIOptions) {
  setupProcessErrorHandlers();
  await cliServe(cliOpts);
}

async function forkCLI(args: string[], runtimeArgs: string[]) {
  const srvxBin = fileURLToPath(
    (globalThis as any).__SRVX_BIN__ || new URL("../bin/srvx.mjs", import.meta.url),
  );
  const child = fork(srvxBin, [...args], {
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
  child.on("message", (msg) => {
    if (msg && (msg as { error?: string }).error === "no-entry") {
      console.error("\n" + c.red(NO_ENTRY_ERROR) + "\n");
      process.exit(3);
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
  process.on("SIGTERM", () => cleanup("SIGTERM", 143));
  // F38: watch mode pushes `--watch` into runtimeArgs (not args), so check there;
  // otherwise the SIGINT handler never installs and the child is orphaned.
  if (runtimeArgs.includes("--watch")) {
    process.on("SIGINT" /* ctrl+c */, () => cleanup("SIGINT", 130));
  }
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

function versions(mainOpts: MainOptions): string[] {
  const versions: string[] = [];
  if (mainOpts.meta?.name) {
    versions.push(`${mainOpts.meta.name} ${mainOpts.meta.version || ""}`.trim());
  }
  versions.push(`${srvxMeta.name} ${srvxMeta.version}`);
  versions.push(runtime());
  return versions;
}

function runtime(): string {
  if (process.versions.bun) {
    return `bun ${process.versions.bun}`;
  } else if (process.versions.deno) {
    return `deno ${process.versions.deno}`;
  } else {
    return `node ${process.versions.node}`;
  }
}
