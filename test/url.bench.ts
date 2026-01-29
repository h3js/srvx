import { bench, compact, summary, group, run, do_not_optimize } from "mitata";
import { FastURL } from "../src/_url.ts";

const input = "https://user:password@example.com:8080/path/to/resource?query=string";

const scenarios = {
  pathname: (url: URL) => do_not_optimize([url.pathname]),
  params: (url: URL) => do_not_optimize([url.searchParams.get("query")]),
  protocol: (url: URL) => do_not_optimize([url.protocol]),
  "pathname+params": (url: URL) => do_not_optimize([url.pathname, url.searchParams.get("query")]),
  "pathname+params+username": (url: URL) =>
    do_not_optimize([url.pathname, url.searchParams.get("query"), url.username]),
};

const benchnames = process.argv[2]?.split(",");

for (const [name, fn] of Object.entries(scenarios)) {
  group(name, () => {
    if (benchnames && !benchnames.includes(name)) {
      return;
    }

    // Ensure both implementations return the same result
    const evaledFn = new Function(
      `return ${fn.toString().replace(/do_not_optimize/g, "")}[0]`,
    )() as (url: URL) => any;
    const nativeRes = evaledFn(new URL(input));
    const fastRes = evaledFn(new FastURL(input));
    if (JSON.stringify(nativeRes) !== JSON.stringify(fastRes)) {
      throw new Error(
        `FastURL result is different from URL: ${JSON.stringify(
          nativeRes,
        )} !== ${JSON.stringify(fastRes)}`,
      );
    }

    summary(() => {
      compact(() => {
        bench("globalThis.URL", () => do_not_optimize(fn(new URL(input))));
        bench("FastURL", () => do_not_optimize(fn(new FastURL(input))));
      });
    });
  });
}

await run({ throw: true });
