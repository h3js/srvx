import type { ServerOptions } from "../src/types.ts";

// Runtime-detected adapter, mirroring `_fixture.ts`.
// prettier-ignore
const runtime = (globalThis as any).Deno ? "deno" : (globalThis.Bun ? "bun" : "node");
const { serve } = (await import(
  `../src/adapters/${runtime}.ts`
)) as typeof import("../src/types.ts");

// Intentionally NO `error` option: with `error` unset the `errorPlugin` no-ops
// and handler exceptions propagate straight to the runtime. This fixture exists
// to observe what each runtime does with an unhandled throw (F9 error paths).
const server = serve({
  hostname: "localhost",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/throw") {
      throw new Error("unhandled sync error");
    }
    if (pathname === "/throw-async") {
      return Promise.reject(new Error("unhandled async error"));
    }
    return new Response("ok");
  },
} satisfies ServerOptions);

await server.ready();
