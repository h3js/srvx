import { glob } from "node:fs/promises";
import * as md from "mdbox";

export default {
  generators: {
    examples: {
      async generate(_ctx) {
        let examples = [];
        for await (const dir of glob("examples/*")) {
          const name = dir.split("/").pop();
          if (name === "stackblitz") continue;

          examples.push([
            `\`${name}\``,
            md.link(`./examples/${name}/`, `examples/${name}`),
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
