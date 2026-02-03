import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import * as c from "./_utils.ts";
import type { CLIOptions, MainOptions } from "./types.ts";
import { cliServe, NO_ENTRY_ERROR } from "./serve.ts";
import { cliFetch } from "./fetch.ts";
import { usage } from "./usage.ts";

export async function main(mainOpts: MainOptions): Promise<void> {
  const args = process.argv.slice(2);
  const cliOpts = parseArgs(args);

  // Running in a child process
  if (process.send) {
    setupProcessErrorHandlers();
    await cliServe(cliOpts);
  }

  // Handle version flag
  if (cliOpts.version) {
    console.log(`srvx ${pkg.version}\n${runtime()}`);
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
      await cliFetch({
        url: cliOpts.url,
        entry: cliOpts.entry,
        dir: cliOpts.dir,
        method: cliOpts.method,
        header: cliOpts.header,
        data: cliOpts.data,
        verbose: cliOpts.verbose,
        host: cliOpts.host,
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
  if (!cliOpts.prod) {
    runtimeArgs.push("--watch");
  }
  if (isNode || isDeno) {
    runtimeArgs.push(
      ...[".env", cliOpts.prod ? ".env.production" : ".env.local"]
        .filter((f) => existsSync(f))
        .map((f) => `--env-file=${f}`),
    );
  }
  if (isNode) {
    const [major, minor] = process.versions.node.split(".");
    if (major === "22" && +minor >= 6) {
      runtimeArgs.push("--experimental-strip-types");
    }
    if (cliOpts.import) {
      runtimeArgs.push(`--import=${cliOpts.import}`);
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
  process.on("SIGINT" /* ctrl+c */, () => cleanup("SIGINT", 130));
  process.on("SIGTERM", () => cleanup("SIGTERM", 143));
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
    // if (positionals[0] === "serve") {
    //   positionals.shift();
    // }
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

function runtime(): string {
  if (process.versions.bun) {
    return `bun ${process.versions.bun}`;
  } else if (process.versions.deno) {
    return `deno ${process.versions.deno}`;
  } else {
    return `node ${process.versions.node}`;
  }
}
