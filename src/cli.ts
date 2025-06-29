#!/usr/bin/env node

/**
 * srvx CLI - Universal HTTP server command line interface
 */

import { parseArgs, showHelp, validateOptions } from "./cli/parser.ts";
import { detectRuntime, getAdapterImport } from "./cli/runtime.ts";
import { loadUserFile } from "./cli/loader.ts";
import packageMetadata from "../package.json" with { type: "json" };

// Get package version
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

    // Detect or use specified runtime
    const runtime = options.runtime || detectRuntime();

    // Load user configuration file
    const userConfig = await loadUserFile(options.file, options, runtime);

    if (!userConfig.success) {
      console.error("Error:", userConfig.error);
      process.exit(1);
    }

    // Import the appropriate srvx adapter
    const adapterPath = getAdapterImport(runtime);
    const srvxModule = await import(adapterPath);

    if (!srvxModule.serve) {
      console.error(`Error: ${adapterPath} does not export a 'serve' function`);
      process.exit(1);
    }

    // Create and start the server
    const server = srvxModule.serve(userConfig.serverOptions);

    // Wait for server to be ready
    await server.ready();

    // Server is now running, the serve() call handles printing the listening message
    // Keep the process alive
    if (runtime === "node") {
      // For Node.js, we need to keep the process alive
      process.on("SIGINT", async () => {
        console.log("\nShutting down server...");
        await server.close();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        console.log("\nShutting down server...");
        await server.close();
        process.exit(0);
      });
    }
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
