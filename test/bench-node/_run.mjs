import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import assert from "node:assert";

let ohaVersion;
try {
  ohaVersion = execSync("oha --version", { encoding: "utf8" }).split(" ")[1];
} catch {
  console.error("Please install `oha` first: https://github.com/hatoo/oha");
}

// System info shown in the console and embedded in the generated README table.
const sysInfo = [
  ["CPU:", cpus()[0]?.model ?? "unknown"],
  ["Node.js:", process.version],
  ["OS:", `${process.platform} ${process.arch}`],
  ["OHA:", ohaVersion],
];

console.log("\n" + sysInfo.map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") + "\n");

const results = [];

const all = process.argv.includes("--all");

const release = process.argv.includes("--release");

const names = [
  "node",
  "srvx",
  "srvx-fast",
  release && "srvx-release",
  release && "srvx-fast-release",
  all && "whatwg-node",
  all && "whatwg-node-fast",
  all && "hono",
  all && "hono-fast",
  all && "remix",
]
  .filter(Boolean)
  .sort(() => (Math.random() > 0.5 ? 1 : -1));

console.log("Running benchmarks for:", names.join(", "));

// Number of measured runs per server (median is reported). Servers within the
// noise floor (~5% run-to-run) can otherwise flip ranks on a single shot.
const TRIES = 3;

// oha invocation shared by the warmup and the measured runs.
const oha = (duration) =>
  execSync(
    `oha http://localhost:3000 --no-tui --output-format json -z ${duration} -H "x-test: 123" -m POST -T "application/json" -d '{"message":"Hello!"}'`,
    { encoding: "utf8" },
  );

// Peak resident memory (MB) of a process. On Linux the kernel tracks the
// high-water mark in `/proc/<pid>/status` (VmHWM), so we get the true peak for
// free — no polling, which matters because `oha` runs via a blocking execSync.
// Falls back to current RSS via `ps` on other platforms.
function peakRssMb(pid) {
  try {
    const hwm = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmHWM:\s+(\d+)\s+kB/);
    if (hwm) return +(Number(hwm[1]) / 1024).toFixed(1);
  } catch {
    // not Linux (or process already gone) — fall through
  }
  try {
    const rss = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim();
    if (rss) return +(Number(rss) / 1024).toFixed(1);
  } catch {
    // no `ps` either
  }
  return null;
}

// Poll the server until it accepts requests (replaces the fixed 200ms sleep so
// a slower cold start doesn't get benchmarked mid-warmup).
async function waitReady(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch("http://localhost:3000", {
        method: "POST",
        body: JSON.stringify({ message: "Hello!" }),
        headers: { "x-test": "123", "Content-Type": "application/json" },
      });
      return res;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not become ready");
}

for (const name of names) {
  process.stdout.write(`${name}...`);
  const entry = fileURLToPath(new URL(`${name}.mjs`, import.meta.url));
  // Spawn as a separate process (not a Worker thread) so its RSS is isolated
  // and measurable.
  const child = spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "inherit"] });

  let samples;
  let mem;
  try {
    const res = await waitReady();

    assert.equal(res.status, 200, `${name} - invalid status code`);
    assert.equal((await res.json()).message, "Hello!");
    assert.equal(res.headers.get("content-type"), "application/json;charset=UTF-8");
    assert.equal(res.headers.get("x-test"), "123", `${name} - missing custom header`);

    // Warmup run (JIT + connection setup) — discarded.
    oha("2sec");

    // https://github.com/hatoo/oha
    samples = [];
    for (let i = 0; i < TRIES; i++) {
      const result = JSON.parse(oha("5sec"));
      const statusCodes = Object.keys(result.statusCodeDistribution);
      if (statusCodes.length > 1 || statusCodes[0] !== "200") {
        throw new Error(`Unexpected status codes: ${statusCodes}`);
      }
      samples.push(Math.round(result.rps.mean));
    }

    // Read the peak RSS before tearing the process down.
    mem = peakRssMb(child.pid);
  } finally {
    // Always reap the child, even on failure, so it can't linger on port 3000
    // and poison the next server's run.
    child.kill("SIGKILL");
    await once(child, "exit"); // free port 3000 before the next server starts
  }

  // Report the median of the samples to be robust against outliers.
  samples.sort((a, b) => a - b);
  const rps = samples[Math.floor(samples.length / 2)];
  results.push([name, { rps, mem }]);
  console.log(
    ` ${rps} req/sec (median of ${samples.join(", ")})${mem == null ? "" : `, peak ${mem} MB`}`,
  );
}

results.sort((a, b) => b[1].rps - a[1].rps);

// `node` is the raw-http baseline every other entry is expressed relative to.
const baseline = results.find(([name]) => name === "node")?.[1];
// `<value> (±X.X%)` vs the baseline. `format` keeps decimals consistent so the
// column stays aligned (e.g. `120.0`, not `120`). The baseline row has no delta.
const withDelta = (value, base, format = (v) => `${v}`) => {
  if (value == null) return "n/a";
  if (base == null || value === base) return format(value);
  const delta = (value / base - 1) * 100;
  return `${format(value)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`;
};

// Minimal GitHub-flavored markdown table with right-aligned numeric columns,
// padded so the raw source is readable in a terminal too.
function markdownTable(headers, rows, align) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s, i) => (align[i] === "right" ? s.padStart(widths[i]) : s.padEnd(widths[i]));
  const sep = widths.map((w, i) =>
    align[i] === "right" ? "-".repeat(w - 1) + ":" : "-".repeat(w),
  );
  const line = (cells) => `| ${cells.map((c, i) => pad(c, i)).join(" | ")} |`;
  return [line(headers), `| ${sep.join(" | ")} |`, ...rows.map(line)].join("\n");
}

const rows = results.map(([name, { rps, mem }]) => [
  name,
  withDelta(rps, baseline?.rps),
  withDelta(mem ?? undefined, baseline?.mem, (v) => v.toFixed(1)),
]);

const table = markdownTable(["server", "req/sec (vs node)", "peak mem MB (vs node)"], rows, [
  "left",
  "right",
  "right",
]);

console.log("\n" + table);

// Update the results section of README.md in place. The region is delimited by
// `<!-- automd:bench -->` … `<!-- /automd -->` so re-running the benchmark just
// swaps the block. Only the full comparison (`--all`) writes back, so a quick
// partial run can't clobber the published table with a subset of the servers.
if (all) {
  const readmePath = fileURLToPath(new URL("README.md", import.meta.url));
  const readme = readFileSync(readmePath, "utf8");
  const region = /(<!--\s*automd:bench\s*-->)[\s\S]*?(<!--\s*\/automd\s*-->)/;
  if (!region.test(readme)) {
    console.error(
      "\nCould not update README.md: missing `<!-- automd:bench -->` … `<!-- /automd -->` markers.",
    );
  } else {
    const block = [
      "```sh",
      sysInfo.map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n"),
      "```",
      "",
      table,
    ].join("\n");
    writeFileSync(readmePath, readme.replace(region, `$1\n\n${block}\n\n$2`));
    console.log(`\nUpdated ${readmePath}`);
  }
}
