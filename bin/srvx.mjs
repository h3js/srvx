#!/usr/bin/env node
import { main } from "../dist/cli.mjs";

await main({
  usage: {
    command: "srvx",
    docs: "https://srvx.h3.dev",
    issues: "https://github.com/h3js/srvx/issues",
  },
});
