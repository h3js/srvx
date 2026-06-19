import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: { enabled: true },
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
