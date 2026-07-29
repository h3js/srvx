// Minimal Cloudflare Workers types. See `src/types/README.md` for why these are inlined.

/**
 * Cloudflare Workers execution context (`ExecutionContext`).
 */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException?(): void;
  props?: any;
}

/**
 * Cloudflare Workers environment bindings.
 *
 * Augment this interface to type your own bindings:
 *
 * ```ts
 * declare module "srvx" {
 *   interface CloudflareEnv {
 *     MY_KV: KVNamespace;
 *   }
 * }
 * ```
 */
export interface CloudflareEnv {
  [key: string]: unknown;
}
