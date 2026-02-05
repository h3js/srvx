#!/usr/bin/env node
import { main } from "../dist/cli.mjs";
import pkg from "../package.json" with { type: "json" };

await main({
  meta: pkg,
  usage: {
    command: "srvx",
    docs: "https://srvx.h3.dev",
    issues: "https://github.com/h3js/srvx/issues",
  },
});
