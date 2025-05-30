import { defineBuildConfig } from "obuild/config";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/types.ts",
        ...[
          "deno",
          "bun",
          "node",
          "cloudflare",
          "generic",
          "service-worker",
        ].map((adapter) => `src/adapters/${adapter}.ts`),
      ],
    },
  ],
  hooks: {
    async end(ctx) {
      await rm(join(ctx.pkgDir, "dist/types.mjs"));
    },
  },
});
