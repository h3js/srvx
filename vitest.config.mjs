import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: { enabled: true },
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
