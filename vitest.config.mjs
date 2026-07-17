import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: { enabled: true },
    // `src/static.ts` imports `FastResponse` from "srvx" at runtime to pick up
    // the adapter matching the runtime (via the `exports` conditions). That
    // self-reference resolves through `dist/`, which `pnpm test` does not
    // build, so point it at the node adapter the tests run on.
    alias: [
      { find: /^srvx$/, replacement: new URL("src/adapters/node.ts", import.meta.url).pathname },
    ],
    // Some tests rely on short real-time timers (~100ms). Under the full suite
    // (lint + typecheck + coverage + parallel forks) the machine can be starved
    // enough to stretch those past the defaults, causing load-only flakes
    // (e.g. http2 "cancel reading body", deno "abort request"). Give headroom.
    testTimeout: 15_000,
    hookTimeout: 20_000,
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/adapters/bun.ts",
        "src/adapters/bunny.ts",
        "src/adapters/cloudflare.ts",
        "src/adapters/deno.ts",
        "src/types.ts",
      ],
      reporter: ["text", "clover", "json", "html"],
    },
  },
});
