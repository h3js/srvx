import { defineBuildConfig } from "obuild/config";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/types.ts",
        "src/cli.ts",
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

      // Make CLI executable on Unix systems
      try {
        const { chmod } = await import("node:fs/promises");
        const cliPath = join(ctx.pkgDir, "dist/cli.mjs");
        await chmod(cliPath, 0o755);
      } catch (error) {
        // Ignore errors on Windows or if file doesn't exist
        console.warn(
          "Could not set executable permission on CLI:",
          error.message,
        );
      }
    },
  },
});
