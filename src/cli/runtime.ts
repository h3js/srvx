/**
 * Runtime detection utilities for srvx CLI
 */

export type SupportedRuntime = "node" | "deno" | "bun";

/**
 * Detect the current JavaScript runtime
 */
export function detectRuntime(): SupportedRuntime {
  // Check for Deno
  if (typeof Deno !== "undefined") {
    return "deno";
  }

  // Check for Bun
  if (typeof Bun !== "undefined") {
    return "bun";
  }

  // Default to Node.js
  return "node";
}

/**
 * Get the appropriate srvx adapter import path for the detected runtime
 */
export function getAdapterImport(runtime: SupportedRuntime): string {
  switch (runtime) {
    case "node": {
      return "srvx/node";
    }
    case "deno": {
      return "srvx/deno";
    }
    case "bun": {
      return "srvx/bun";
    }
    default: {
      return "srvx/generic";
    }
  }
}

/**
 * Check if TypeScript files can be executed directly in the current runtime
 */
export function supportsTypeScript(runtime: SupportedRuntime): boolean {
  switch (runtime) {
    case "deno": {
      return true;
    }
    case "bun": {
      return true;
    }
    case "node": {
      // Node.js supports TypeScript with --experimental-strip-types (Node 22.6+)
      const nodeVersion = process.version;
      const major = Number.parseInt(nodeVersion.slice(1).split(".")[0], 10);
      const minor = Number.parseInt(nodeVersion.split(".")[1], 10);
      return major > 22 || (major === 22 && minor >= 6);
    }
    default: {
      return false;
    }
  }
}
