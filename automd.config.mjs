import { glob } from "node:fs/promises";
import * as md from "mdbox";
import { fileURLToPath } from "node:url";

export default {
  input: ["README.md", "docs/**/*.md"],
  generators: {
    examples: {
      async generate(_ctx) {
        let examples = [];
        for await (const dir of glob(
          fileURLToPath(new URL("examples/*", import.meta.url)),
        )) {
          const name = dir.split("/").pop();
          if (name === "stackblitz") continue;

          examples.push([
            `\`${name}\``,
            md.link(
              `https://github.com/h3js/srvx/tree/main/examples/${name}/`,
              `examples/${name}`,
            ),
            `\`npx giget gh:h3js/srvx/examples/${name}\``,
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
