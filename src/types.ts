import type { Server, ServerOptions } from "./_types/core.mjs";

// Universal entry: re-exports the types of every supported runtime.
// Import from `srvx/<runtime>` instead to only pull in the types of that runtime.
export * from "./_types/core.mjs";
export * from "./_types/node.mjs";
export * from "./_types/bun.mjs";
export * from "./_types/deno.mjs";
export * from "./_types/cloudflare.mjs";
export * from "./_types/aws-lambda.mjs";
export * from "./_types/service-worker.mjs";

// ----------------------------------------------------------------------------
// srvx API
// ----------------------------------------------------------------------------

/**
 * Faster URL constructor with lazy access to pathname and search params (For Node, Deno, and Bun).
 */
export declare const FastURL: typeof globalThis.URL;

/**
 * Faster Response constructor optimized for Node.js (same as Response for other runtimes).
 */
export declare const FastResponse: typeof globalThis.Response;

/**
 * Create a new server instance.
 */
export declare function serve(options: ServerOptions): Server;
