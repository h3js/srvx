import { Worker } from "node:worker_threads";
import { execSync } from "node:child_process";
import assert from "node:assert";

let ohaVersion;
try {
  ohaVersion = execSync("oha --version", { encoding: "utf8" }).split(" ")[1];
} catch {
  console.error("Please install `oha` first: https://github.com/hatoo/oha");
}

console.log(`
Node.js:\t ${process.version}
OS:\t\t ${process.platform} ${process.arch}
OHA:\t\t ${ohaVersion}
`);

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

for (const name of names) {
  process.stdout.write(`${name}...`);
  const entry = new URL(`${name}.mjs`, import.meta.url);
  const worker = new Worker(entry, { type: "module" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const res = await fetch("http://localhost:3000", {
    method: "POST",
    body: JSON.stringify({ message: "Hello!" }),
    headers: { "x-test": "123", "Content-Type": "application/json" },
  });

  assert.equal(res.status, 200, `${name} - invalid status code`);
  assert.equal((await res.json()).message, "Hello!");
  assert.equal(res.headers.get("content-type"), "application/json;charset=UTF-8");
  assert.equal(res.headers.get("x-test"), "123", `${name} - missing custom header`);

  // https://github.com/hatoo/oha
  const stdout = execSync(
    `oha http://localhost:3000 --no-tui --output-format json -z 3sec -H "x-test: 123" -m POST -T "application/json" -d '{"message":"Hello!"}'`,
    {
      encoding: "utf8",
    },
  );
  worker.terminate();
  const result = JSON.parse(stdout);
  const statusCodes = Object.keys(result.statusCodeDistribution);
  if (statusCodes.length > 1 || statusCodes[0] !== "200") {
    throw new Error(`Unexpected status codes: ${statusCodes}`);
  }
  const rps = Math.round(result.rps.mean);
  results.push([name, `${rps} req/sec`]);
  console.log(` ${rps} req/sec`);
}

results.sort((a, b) => b[1].split(" ")[0] - a[1].split(" ")[0]);

console.table(Object.fromEntries(results));
