import { defineBuildConfig } from "obuild/config";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/types.ts",
        "src/cli.ts",
        "src/static.ts",
        "src/log.ts",
        ...[
          "deno",
          "bun",
          "node",
          "cloudflare",
          "generic",
          "service-worker",
        ].map((adapter) => `src/adapters/${adapter}.ts`),
      ],
      rolldown: {
        plugins: [
          pkg.name === "srvx-nightly" && {
            name: "nightly-alias",
            resolveId(id) {
              if (id.startsWith("srvx")) {
                return {
                  id: id.replace("srvx", "srvx-nightly"),
                  external: true,
                };
              }
            },
          },
        ],
      },
    },
  ],
  hooks: {
    async end(ctx) {
      await rm(join(ctx.pkgDir, "dist/types.mjs"));
    },
  },
});
