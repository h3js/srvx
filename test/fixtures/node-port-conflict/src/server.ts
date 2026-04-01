import { serve } from "../../../../src/adapters/node.ts";

const port = Number(process.env.PORT);

process.once("uncaughtException", (error) => {
  console.log("uncaught", (error as { code?: string })?.code, error.message);
  process.exit(99);
});

const server1 = serve({ port, fetch: () => new Response("one") });
await server1.ready();

try {
  const server2 = serve({ port, fetch: () => new Response("two") });
  await Promise.race([
    server2.ready(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("startup timeout")), 500)),
  ]);

  console.log("unexpected-ready");
  process.exit(2);
} catch (error) {
  console.log(
    "caught",
    (error as { code?: string })?.code,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await server1.close(true);
}
