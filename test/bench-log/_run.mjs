// Measures the throughput cost of the `srvx/log` middleware.
//
// `log()` buffers lines and flushes once per event-loop turn, so its overhead
// only shows up under real concurrency (many requests completing in the same
// turn share one write). An in-process loop can't reproduce that — a single
// keep-alive connection serialises the requests — so this drives a real server
// with `oha`, exactly like `test/bench-node`.
//
// Two things move the number and both are worth isolating, hence the matrix:
//   impl  none → no logger (baseline)   |  log → the middleware
//   sink  devnull | pipe | file         → where the logged lines land
// `pipe` (logs streamed to a collector) is the most representative of production.
//
//   pnpm bench:log
//
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { openSync, closeSync } from "node:fs";
import assert from "node:assert";

let ohaVersion;
try {
  ohaVersion = execSync("oha --version", { encoding: "utf8" }).split(" ")[1];
} catch {
  console.error("Please install `oha` first: https://github.com/hatoo/oha");
  process.exit(1);
}

const sysInfo = [
  ["CPU:", cpus()[0]?.model ?? "unknown"],
  ["Node.js:", process.version],
  ["OS:", `${process.platform} ${process.arch}`],
  ["OHA:", ohaVersion],
];
console.log("\n" + sysInfo.map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") + "\n");

// Number of concurrent connections and the measured window. 64 connections is
// enough to keep many requests completing per event-loop turn, which is the
// regime the batching is built for.
const CONNS = Number(process.env.CONNS || 64);
const WARMUP = process.env.WARMUP || "2sec";
const DURATION = process.env.DURATION || "5sec";
// Measured runs per cell; the median is reported to shrug off outliers.
const TRIES = Number(process.env.TRIES || 3);

const IMPLS = ["none", "log"];
// `null` means /dev/null (discard), which isolates the logger's CPU/formatting
// cost from any real I/O; `pipe` and `file` add back the two realistic sinks.
const SINKS = [
  { name: "devnull", open: () => openSync("/dev/null", "w") },
  { name: "pipe", open: () => "pipe" },
  { name: "file", open: () => openSync(fileURLToPath(new URL("bench.log", import.meta.url)), "w") },
];

const oha = (duration) =>
  execSync(
    `oha http://localhost:3000 --no-tui --output-format json -c ${CONNS} -z ${duration}`,
    { encoding: "utf8" },
  );

async function waitReady(retries = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch("http://localhost:3000");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not become ready");
}

// One measured cell: spawn a server with `impl`, stream its stdout to `sink`,
// hammer it, and return the median rps. The child is always reaped so it can't
// hold port 3000 into the next cell.
async function measure(impl, sink) {
  const fd = sink.open();
  const drainForPipe = fd === "pipe";
  const child = spawn(process.execPath, [fileURLToPath(new URL("_server.mjs", import.meta.url))], {
    env: { ...process.env, IMPL: impl },
    // stdout → the sink under test; stderr inherited so the readiness line and
    // any crash surface in the console.
    stdio: ["ignore", drainForPipe ? "pipe" : fd, "inherit"],
  });
  // A real pipe blocks the writer once the OS buffer fills, so it must be
  // drained to mimic a downstream reader (e.g. a log collector) keeping up.
  if (drainForPipe) child.stdout.resume();

  try {
    const res = await waitReady();
    assert.equal(res.status, 200, `${impl}/${sink.name} - unexpected status`);

    oha(WARMUP); // JIT + connection setup, discarded

    const samples = [];
    for (let i = 0; i < TRIES; i++) {
      const result = JSON.parse(oha(DURATION));
      const codes = Object.keys(result.statusCodeDistribution);
      if (codes.length > 1 || codes[0] !== "200") {
        throw new Error(`Unexpected status codes: ${codes}`);
      }
      samples.push(Math.round(result.rps.mean));
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit"); // free port 3000 before the next cell
    if (typeof fd === "number") closeSync(fd);
  }
}

// Build the full list of cells and shuffle it, so slow machine drift (thermal
// throttling, a background task) can't systematically favour whichever impl
// always runs last.
const cells = [];
for (const sink of SINKS) for (const impl of IMPLS) cells.push({ sink, impl });
cells.sort(() => (Math.random() > 0.5 ? 1 : -1));

const rps = {}; // rps[sink][impl]
for (const { sink, impl } of cells) {
  process.stdout.write(`${sink.name}/${impl}...`);
  const value = await measure(impl, sink);
  (rps[sink.name] ??= {})[impl] = value;
  console.log(` ${value.toLocaleString()} req/sec`);
}

// Right-aligned GFM table, padded so the raw markdown is readable in a terminal.
function markdownTable(headers, rows, align) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s, i) => (align[i] === "right" ? s.padStart(widths[i]) : s.padEnd(widths[i]));
  const sep = widths.map((w, i) => (align[i] === "right" ? "-".repeat(w - 1) + ":" : "-".repeat(w)));
  const line = (cells) => `| ${cells.map((c, i) => pad(c, i)).join(" | ")} |`;
  return [line(headers), `| ${sep.join(" | ")} |`, ...rows.map(line)].join("\n");
}

const rows = SINKS.map(({ name }) => {
  const none = rps[name].none;
  const withLog = rps[name].log;
  // Overhead = throughput given up by adding the logger, relative to no logger.
  const overhead = ((none - withLog) / none) * 100;
  return [
    name,
    none.toLocaleString(),
    withLog.toLocaleString(),
    `-${overhead.toFixed(1)}%`,
  ];
});

const table = markdownTable(
  ["sink", "no logger", "log()", "overhead"],
  rows,
  ["left", "right", "right", "right"],
);
console.log("\n" + table + "\n");
