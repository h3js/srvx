import { defineBuildConfig } from "obuild/config";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

/**
 * Remove a `declare module "<spec>" { ... }` augmentation block from emitted `.d.mts`.
 *
 * `src/mtls.ts` augments both `"srvx"` (for consumers) and `"./types.ts"` (so srvx's
 * own type-check resolves `request.tls` through the relative source module). The latter
 * is meaningless in the published bundle — `./types.ts` does not exist there — and only
 * survives into `dist/mtls.d.mts` because `skipLibCheck` hides it. Strip it at build time.
 */
function stripDeclareModule(code, spec) {
  const marker = `declare module "${spec}" {`;
  const start = code.indexOf(marker);
  if (start === -1) {
    return code;
  }
  let depth = 0;
  let end = start + marker.length - 1; // index of the opening brace
  for (; end < code.length; end++) {
    const ch = code[end];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  if (code[end] === "\n") {
    end++;
  }
  return code.slice(0, start) + code.slice(end);
}

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/types.ts",
        "src/cli.ts",
        "src/static.ts",
        "src/log.ts",
        "src/tracing.ts",
        "src/loader.ts",
        "src/mtls.ts",
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

      // Strip the dead `declare module "./types.ts"` augmentation (see helper above).
      const mtlsDts = join(ctx.pkgDir, "dist/mtls.d.mts");
      const contents = await readFile(mtlsDts, "utf8");
      await writeFile(mtlsDts, stripDeclareModule(contents, "./types.ts"));
    },
  },
});
