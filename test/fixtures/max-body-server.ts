// Minimal server used by the cross-runtime maxRequestBodySize tests. Spawned under the
// target runtime (bun/deno); reads PORT from the env like the main fixture.
const runtime = (globalThis as any).Deno ? "deno" : (globalThis as any).Bun ? "bun" : "node";
const { serve } = (await import(
  `../../src/adapters/${runtime}.ts`
)) as typeof import("../../src/types.ts");

serve({
  hostname: "localhost",
  maxRequestBodySize: 8,
  fetch: async (req) => {
    try {
      // Read via the whole native body path so streaming/native reads are exercised.
      const body = await req.arrayBuffer();
      return new Response(`OK:${body.byteLength}`);
    } catch (error: any) {
      return new Response(error.code ?? "ERR", { status: error.statusCode ?? 500 });
    }
  },
});
