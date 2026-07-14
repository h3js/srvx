// Test runner: invokes the srvx CLI from source (no dist build required).
// Node strips TypeScript types on the fly (Node >= 22.18 / 24).
import { main } from "../src/cli.ts";

// Point any forked child at this same source runner instead of ./bin/srvx.mjs.
(globalThis as any).__SRVX_BIN__ = new URL("./_cli-run.ts", import.meta.url).href;

await main({
  usage: {
    command: "srvx",
    docs: "https://srvx.h3.dev",
    issues: "https://github.com/h3js/srvx/issues",
  },
});
