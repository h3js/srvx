import { defineBuildConfig } from "obuild/config";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/types.ts",
        ...["core", "node", "bun", "deno", "cloudflare", "aws-lambda", "service-worker"].map(
          (runtime) => `src/_types/${runtime}.mts`,
        ),
        "src/cli.ts",
        "src/static.ts",
        "src/log.ts",
        "src/tracing.ts",
        "src/loader.ts",
        "src/mtls.ts",
        "src/body-limit.ts",
        ...[
          "deno",
          "bun",
          "bunny",
          "node",
          "cloudflare",
          "generic",
          "service-worker",
          "aws-lambda",
        ].map((adapter) => `src/adapters/${adapter}.ts`),
      ],
      rolldown: {
        // Keep `src/_types/*` in their own entry instead of a facade re-exporting a
        // shared chunk, so consumers augment the module that declares the types.
        preserveEntrySignatures: "allow-extension",
        external: ["bun", "@cloudflare/workers-types", "aws-lambda"],
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

      // Runtime types are registered by augmenting the core types module. Relative
      // specifiers only resolve from where the source files live, so rewrite them to
      // the public `<pkg>/types` subpath, which resolves from any emitted chunk.
      const distDir = join(ctx.pkgDir, "dist");
      const files = await readdir(distDir, { recursive: true });
      for (const file of files) {
        if (!file.endsWith(".d.mts")) continue;
        const path = join(distDir, file);
        const code = await readFile(path, "utf8");
        const patched = code.replaceAll(
          /declare module "[^"]*\/core\.mjs"/g,
          `declare module "${pkg.name}/types"`,
        );
        if (patched !== code) {
          await writeFile(path, patched);
        }
      }
    },
  },
});
