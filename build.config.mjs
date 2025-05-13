import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "deno",
        "bun",
        "node",
        "cloudflare",
        "generic",
        "service-worker",
      ].map((adapter) => `src/adapters/${adapter}.ts`),
    },
  ],
});
