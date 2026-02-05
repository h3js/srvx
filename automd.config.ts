import { glob } from "node:fs/promises";
import * as md from "mdbox";
import { fileURLToPath } from "node:url";
import pkg from "./package.json" with { type: "json" };

export default {
  input: ["README.md", "docs/**/*.md"],
  generators: {
    cliUsage: {
      async generate(_ctx: any) {
        process.env.NO_COLOR = "1";
        const { usage } = await import("./src/cli/usage.ts");
        delete process.env.NO_COLOR;
        const _usage = usage({
          meta: {
            name: "srvx",
            description: pkg.description,
            version: " ",
          },
        });
        return {
          contents: md.codeBlock(_usage, "sh"),
        };
      },
    },
    examples: {
      async generate(_ctx: any) {
        const examples: string[][] = [];
        for await (const dir of glob(fileURLToPath(new URL("examples/*", import.meta.url)))) {
          const name = dir.split("/").pop();
          if (name === "stackblitz") continue;

          examples.push([
            `\`${name}\``,
            md.link(`https://github.com/h3js/srvx/tree/main/examples/${name}/`, `examples/${name}`),
            `\`npx giget gh:h3js/srvx/examples/${name} srvx-${name}\``,
          ]);
        }
        return {
          contents: md.table({
            columns: ["Example", "Source", "Try"],
            rows: examples,
          }),
        };
      },
    },
  },
};
