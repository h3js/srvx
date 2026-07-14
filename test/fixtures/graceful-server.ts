// Fixture for the graceful-shutdown integration tests. Spawned as a child
// process so real SIGINT/SIGTERM signals can be delivered without terminating
// the test runner. `gracefulShutdown: true` forces the plugin on even under
// `CI`/`TEST` (which otherwise auto-disable it). Reads PORT from the env.
const runtime = (globalThis as any).Deno ? "deno" : (globalThis as any).Bun ? "bun" : "node";
const { serve } = (await import(
  `../../src/adapters/${runtime}.ts`
)) as typeof import("../../src/types.ts");

const gracefulTimeout = process.env.GRACEFUL_TIMEOUT
  ? { gracefulTimeout: Number(process.env.GRACEFUL_TIMEOUT) }
  : true;

const server = serve({
  hostname: "localhost",
  port: Number(process.env.PORT || 0),
  gracefulShutdown: gracefulTimeout,
  silent: true,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/slow") {
      // In-flight when the signal arrives; graceful shutdown must let it finish.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response("slow-done");
    }
    if (url.pathname === "/hang") {
      // Never responds — exercises the graceful-timeout -> force-close path.
      await new Promise(() => {});
    }
    return new Response("ok");
  },
});

await server.ready();
