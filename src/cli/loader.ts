/**
 * User file loader for srvx CLI
 */

import type { ServerOptions } from "../types.ts";
import type { CLIOptions } from "./parser.ts";
import { supportsTypeScript, type SupportedRuntime } from "./runtime.ts";

export interface UserConfig {
  /** Server options to pass to srvx.serve() */
  serverOptions: ServerOptions;
  /** Whether the file was successfully loaded */
  success: boolean;
  /** Error message if loading failed */
  error?: string;
}

/**
 * Load and parse user configuration file
 */
export async function loadUserFile(
  filePath: string,
  cliOptions: CLIOptions,
  runtime: SupportedRuntime,
): Promise<UserConfig> {
  try {
    // Check if file exists and is accessible
    const resolvedPath = await resolveFilePath(filePath, runtime);
    if (!resolvedPath) {
      return {
        success: false,
        error: `File not found: ${filePath}`,
        serverOptions: {} as ServerOptions,
      };
    }

    // Check TypeScript support
    if (resolvedPath.endsWith(".ts") && supportsTypeScript(runtime) === false) {
      return {
        success: false,
        error: `TypeScript files are not supported in ${runtime} runtime. Please use a .js file or switch to Deno/Bun.`,
        serverOptions: {} as ServerOptions,
      };
    }

    // Import the user file
    const userModule = await importUserFile(resolvedPath, runtime);

    // Parse the exported configuration
    const serverOptions = parseUserConfig(userModule, cliOptions);

    return {
      success: true,
      serverOptions,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to load file: ${error instanceof Error ? error.message : String(error)}`,
      serverOptions: {} as ServerOptions,
    };
  }
}

/**
 * Resolve file path with extension inference
 */
async function resolveFilePath(
  filePath: string,
  _runtime: SupportedRuntime,
): Promise<string | null> {
  // Try exact path first
  if (await fileExists(filePath)) {
    return filePath;
  }

  // Try with common extensions
  const extensions = [".js", ".mjs", ".ts"];
  for (const ext of extensions) {
    const pathWithExt = filePath + ext;
    if (await fileExists(pathWithExt)) {
      return pathWithExt;
    }
  }

  return null;
}

/**
 * Check if file exists (runtime-agnostic)
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    if (typeof Deno !== "undefined") {
      await Deno.stat(path);
      return true;
    }
    if (typeof Bun !== "undefined") {
      const file = Bun.file(path);
      return await file.exists();
    }

    // Node.js
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import user file (runtime-specific)
 */
async function importUserFile(
  filePath: string,
  runtime: SupportedRuntime,
): Promise<any> {
  // Convert to file:// URL for consistent imports
  const fileUrl = filePath.startsWith("/")
    ? `file://${filePath}`
    : filePath.startsWith("file://")
      ? filePath
      : `file://${process.cwd()}/${filePath}`;

  try {
    const module = await import(fileUrl);
    return module;
  } catch (error) {
    // Fallback for Node.js with relative paths
    if (
      runtime === "node" &&
      !filePath.startsWith("/") &&
      !filePath.startsWith("file://")
    ) {
      const { resolve } = await import("node:path");
      const absolutePath = resolve(process.cwd(), filePath);
      const module = await import(`file://${absolutePath}`);
      return module;
    }
    throw error;
  }
}

/**
 * Parse user configuration from imported module
 */
function parseUserConfig(
  userModule: any,
  cliOptions: CLIOptions,
): ServerOptions {
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
}

/**
 * Create ServerOptions by merging user config with CLI options
 */
function createServerOptions(
  userConfig: any,
  cliOptions: CLIOptions,
): ServerOptions {
  const serverOptions: ServerOptions = {
    fetch: userConfig.fetch,
  };

  // Merge user configuration
  if (userConfig.port !== undefined) serverOptions.port = userConfig.port;
  if (userConfig.hostname !== undefined)
    serverOptions.hostname = userConfig.hostname;
  if (userConfig.host !== undefined) serverOptions.hostname = userConfig.host; // alias
  if (userConfig.protocol !== undefined)
    serverOptions.protocol = userConfig.protocol;
  if (userConfig.tls !== undefined) serverOptions.tls = userConfig.tls;
  if (userConfig.middleware !== undefined)
    serverOptions.middleware = userConfig.middleware;
  if (userConfig.plugins !== undefined)
    serverOptions.plugins = userConfig.plugins;
  if (userConfig.error !== undefined) serverOptions.error = userConfig.error;

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
