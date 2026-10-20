// Minimal server used by the cross-runtime `unix` option tests. Spawned under the
// target runtime (bun/deno) with `SOCKET_PATH` (and optionally `TLS_CERT`/`TLS_KEY`)
// in the env. Prints `server.url` once listening; closes on any stdin input.
const runtime = (globalThis as any).Deno ? "deno" : (globalThis as any).Bun ? "bun" : "node";
const { serve } = (await import(
  `../../src/adapters/${runtime}.ts`
)) as typeof import("../../src/types.ts");

const env = globalThis.process.env;

const server = serve({
  unix: env.SOCKET_PATH,
  tls: env.TLS_CERT ? { cert: env.TLS_CERT, key: env.TLS_KEY } : undefined,
  fetch: async (req) => new Response(`ok ${req.url} ${await req.text()}`.trim()),
});

await server.ready();
console.log(`url=${server.url}`);

globalThis.process.stdin.once("data", async () => {
  await server.close();
  console.log("closed");
  globalThis.process.exit(0);
});
