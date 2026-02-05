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
  const args = process.argv.slice(2);
  const cliOpts = parseArgs(args);

  // Handle version flag
  if (cliOpts.version) {
    process.stdout.write(versions(mainOpts).join("\n") + "\n");
    process.exit(0);
  }
  // Handle help flag
  if (cliOpts.help) {
    console.log(usage(mainOpts));
    process.exit(cliOpts.help ? 0 : 1);
  }

  // Fetch mode
  if (cliOpts.mode === "fetch") {
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
    return startServer(mainOpts, cliOpts);
  }

  // Resolve .env files
  const envFiles = [".env", cliOpts.prod ? ".env.production" : ".env.local"].filter((f) =>
    existsSync(f),
  );
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
    await startServer(mainOpts, cliOpts);
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
  const pArg0 = args.find((a) => !a.startsWith("-"));
  const mode = pArg0 === "fetch" || pArg0 === "curl" ? "fetch" : "serve";

  const commonArgs = {
    help: { type: "boolean" },
    version: { type: "boolean" },
    dir: { type: "string" },
    entry: { type: "string" },
    host: { type: "string" },
    hostname: { type: "string" },
    tls: { type: "boolean" },
  } as const;

  if (mode === "serve") {
    // Serve mode
    const { values, positionals } = parseNodeArgs({
      args,
      allowPositionals: true,
      options: {
        ...commonArgs,
        url: { type: "string" },
        prod: { type: "boolean" },
        port: { type: "string", short: "p" },
        static: { type: "string", short: "s" },
        import: { type: "string" },
        cert: { type: "string" },
        key: { type: "string" },
      },
    });
    if (positionals[0] === "serve") {
      positionals.shift();
    }

    // Backward compatibility: allow entry or dir as positional argument
    const maybeEntryOrDir = positionals[0];
    if (maybeEntryOrDir) {
      if (values.entry || values.dir) {
        throw new Error(
          "Cannot specify entry or dir as positional argument when --entry or --dir is used!",
        );
      }
      const stat = statSync(maybeEntryOrDir);
      if (stat.isDirectory()) {
        values.dir = maybeEntryOrDir;
      } else {
        values.entry = maybeEntryOrDir;
      }
    }

    return { mode, ...values };
  }

  // Fetch mode
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    options: {
      ...commonArgs,
      url: { type: "string" },
      method: { type: "string", short: "X" },
      request: { type: "string" }, // curl compatibility
      header: { type: "string", multiple: true, short: "H" },
      verbose: { type: "boolean", short: "v" },
      data: { type: "string", short: "d" },
    },
  });
  if (positionals[0] === "fetch" || positionals[0] === "curl") {
    positionals.shift();
  }
  const method = values.method || values.request;
  const url = values.url || positionals[0] || "/";
  return { mode, ...values, url, method };
}

async function startServer(mainOpts: MainOptions, cliOpts: CLIOptions) {
  console.log(c.gray([...versions(mainOpts), cliOpts.prod ? "prod" : "dev"].join(" · ")));
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
  if (args.includes("--watch")) {
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
