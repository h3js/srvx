import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../dist");

// Runtime types a consumer only has when the matching (optional) types package is installed.
const runtimeTypeRefs: Record<string, RegExp> = {
  bun: /from "bun"/,
  "aws-lambda": /from "aws-lambda"/,
  cloudflare: /from "(@cloudflare\/workers-types|cloudflare:\w+)"/,
  deno: /\bDeno\./,
  "service-worker": /:\s*FetchEvent\b|\bextends FetchEvent\b/,
};

/** Every declaration file reachable from an entry, following relative imports. */
async function declarationClosure(entry: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [join(distDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    const code = await readFile(file, "utf8");
    // Comments mention other runtimes without referencing their types.
    files.set(file, code.replaceAll(/\/\*[\S\s]*?\*\//g, ""));
    for (const [, specifier] of files.get(file)!.matchAll(/(?:from|import) "(\.[^"]+)"/g)) {
      queue.push(join(dirname(file), specifier.replace(/\.mjs$/, ".d.mts")));
    }
  }
  return files;
}

describe.skipIf(!existsSync(distDir))("published declarations", () => {
  // Entries that are not tied to a runtime must not reference any of their types,
  // so that a consumer can type check them without `skipLibCheck`. See #284.
  for (const entry of [
    "_types/core.d.mts",
    "static.d.mts",
    "log.d.mts",
    "body-limit.d.mts",
    "tracing.d.mts",
    "mtls.d.mts",
    "cli.d.mts",
  ]) {
    test(entry, async () => {
      const closure = await declarationClosure(entry);
      const leaks = [...closure]
        .flatMap(([file, code]) =>
          Object.entries(runtimeTypeRefs)
            .filter(([, pattern]) => pattern.test(code))
            .map(([runtime]) => `${file.slice(distDir.length + 1)}: ${runtime}`),
        )
        .sort();
      expect(leaks).toEqual([]);
    });
  }

  // Runtime entries only reference the types of their own runtime.
  for (const [runtime, entry] of [
    ["bun", "adapters/bun.d.mts"],
    ["deno", "adapters/deno.d.mts"],
    ["cloudflare", "adapters/cloudflare.d.mts"],
    ["aws-lambda", "adapters/aws-lambda.d.mts"],
    ["service-worker", "adapters/service-worker.d.mts"],
  ] as const) {
    test(entry, async () => {
      const closure = await declarationClosure(entry);
      const foreign = [...closure]
        .flatMap(([, code]) =>
          Object.entries(runtimeTypeRefs)
            .filter(([name, pattern]) => name !== runtime && pattern.test(code))
            .map(([name]) => name),
        )
        .sort();
      expect(foreign).toEqual([]);
    });
  }
});
