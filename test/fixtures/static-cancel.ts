// Spawned under Bun by `test/bun.test.ts`: static responses whose client hangs
// up mid-body must not leave their `FileHandle` to GC, which Bun treats as a
// fatal error (h3js/srvx#341). Prints "ok" and exits 0 when no handle leaked.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `src/static.ts` imports `FastResponse` from "srvx", which resolves through
// `dist/`; serve the bun adapter source under that name instead.
const bunAdapter = await import("../../src/adapters/bun.ts");
Bun.plugin({
  name: "srvx-self",
  setup(build) {
    build.module("srvx", () => ({ exports: bunAdapter, loader: "object" }));
  },
});

const { staticMiddleware } = await import("../../src/static.ts");
// Both adapters run with this `FastResponse` (the native `Response`), as they do
// under Bun outside of tests.
const adapters = {
  bun: bunAdapter,
  node: await import("../../src/adapters/node.ts"),
};

const dir = await mkdtemp(join(tmpdir(), "srvx-static-cancel-"));
// Large enough that the response is still streaming when the client hangs up;
// `.txt` is compressible, so `Accept-Encoding` takes the on-the-fly path. Random
// letters keep the gzip output large, so it is still streaming too.
const letters = new Uint8Array(4 * 1024 * 1024);
for (let i = 0, seed = 1; i < letters.length; i++) {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
  letters[i] = 97 + ((seed >>> 16) % 26);
}
await writeFile(join(dir, "big.txt"), letters);
await writeFile(join(dir, "big.bin"), new Uint8Array(4 * 1024 * 1024));

const requests = [
  "GET /big.bin HTTP/1.1\r\nHost: localhost\r\n\r\n",
  "GET /big.bin HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-3999999\r\n\r\n",
  "GET /big.txt HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n",
];

// A client that hangs up right after sending the request, or once the first
// bytes of the response arrive.
const abortedRequest = (port: number, raw: string, afterData: boolean) =>
  new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(raw);
      if (afterData) {
        socket.once("data", () => socket.destroy());
      } else {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => resolve());
  });

try {
  for (const [name, { serve }] of Object.entries(adapters)) {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      middleware: [staticMiddleware({ dir })],
      fetch: () => new Response("Not Found", { status: 404 }),
    });
    try {
      await server.ready();
      const port = Number(new URL(server.url!).port);
      // Bodies a client does read still arrive whole.
      const base = `http://127.0.0.1:${port}`;
      const full = await fetch(`${base}/big.bin`);
      const range = await fetch(`${base}/big.bin`, { headers: { Range: "bytes=10-19" } });
      const gzip = await fetch(`${base}/big.txt`, { headers: { "Accept-Encoding": "gzip" } });
      const checks = [
        full.status === 200 && (await full.arrayBuffer()).byteLength === 4 * 1024 * 1024,
        range.status === 206 && (await range.arrayBuffer()).byteLength === 10,
        gzip.headers.get("content-encoding") === "gzip" &&
          (await gzip.text()).length === 4 * 1024 * 1024,
      ];
      if (checks.includes(false)) {
        throw new Error(`${name}: unexpected response bodies ${JSON.stringify(checks)}`);
      }
      for (let i = 0; i < 10; i++) {
        for (const raw of requests) {
          await abortedRequest(port, raw, false);
          await abortedRequest(port, raw, true);
        }
      }
      for (let i = 0; i < 3; i++) {
        Bun.gc(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await server.close(true);
    }
    console.log(`${name}: ok`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("ok");
