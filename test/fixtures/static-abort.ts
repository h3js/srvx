// Regression for h3js/srvx#341. Spawned under Bun: clients hang up on static
// file responses before they are sent, then GC runs. Bun treats a `FileHandle`
// collected while still open as a fatal error, so the process only reaches
// "ok" when every aborted response closed its file.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `src/static.ts` imports `FastResponse` from "srvx", which resolves to the
// built `dist/`. Point it at the source Bun adapter instead so the fixture runs
// without a build (Bun runtime plugins can't `onResolve` bare specifiers).
const adapter = new URL("../../src/adapters/bun.ts", import.meta.url).pathname;
Bun.plugin({
  name: "srvx-src",
  setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]static\.ts$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replace(
        'from "srvx"',
        `from ${JSON.stringify(adapter)}`,
      ),
      loader: "ts",
    }));
  },
});

const { staticMiddleware } = await import("../../src/static.ts");
const dir = await mkdtemp(join(tmpdir(), "srvx-static-abort-"));
// Large enough that the response is still streaming when the client hangs up.
await writeFile(join(dir, "font.woff2"), Buffer.alloc(2 * 1024 * 1024, 1)); // identity
await writeFile(join(dir, "app.js"), "x".repeat(2 * 1024 * 1024)); // compressed on the fly

const abortedGet = (port: number, path: string, headers = "") =>
  new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`);
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.once("close", () => resolve());
  });

// Both the native Bun adapter and `srvx/node` running on Bun are affected.
for (const name of ["bun", "node"]) {
  const { serve } = (await import(
    `../../src/adapters/${name}.ts`
  )) as typeof import("../../src/types.ts");
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    middleware: [staticMiddleware({ dir })],
    fetch: () => new Response("not found", { status: 404 }),
  });
  await server.ready();
  const port = Number(new URL(server.url!).port);

  for (let i = 0; i < 20; i++) {
    await abortedGet(port, "/font.woff2");
    await abortedGet(port, "/font.woff2", "Range: bytes=0-1048575\r\n");
    await abortedGet(port, "/app.js", "Accept-Encoding: gzip\r\n");
  }

  // Bodies that are read in full are still served intact.
  const base = `http://127.0.0.1:${port}`;
  const full = await fetch(`${base}/font.woff2`);
  assert.equal((await full.arrayBuffer()).byteLength, 2 * 1024 * 1024);
  const range = await fetch(`${base}/font.woff2`, { headers: { range: "bytes=10-19" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  const gzip = await fetch(`${base}/app.js`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.equal(await gzip.text(), "x".repeat(2 * 1024 * 1024));

  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await server.close(true);
}

await rm(dir, { recursive: true, force: true });
console.log("ok");
