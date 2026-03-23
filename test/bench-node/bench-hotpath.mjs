/**
 * Node.js hot-path microbenchmark — measures request/response conversion overhead.
 *
 * No external tools needed. Sends sequential HTTP requests and measures latency.
 *
 * Run: node test/bench-node/bench-hotpath.mjs
 */

import { serve, FastResponse } from "srvx";

const REQUESTS = 5000;
const WARMUP = 500;

// Use FastResponse to measure adapter overhead (not Undici Response overhead)
globalThis.Response = FastResponse;

async function measure(url, n) {
  const times = [];

  for (let i = 0; i < WARMUP; i++) {
    const res = await fetch(url, {
      method: "POST",
      body: '{"message":"Hello!"}',
      headers: { "content-type": "application/json", "x-test": "123" },
    });
    await res.json();
  }

  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fetch(url, {
      method: "POST",
      body: '{"message":"Hello!"}',
      headers: { "content-type": "application/json", "x-test": "123" },
    });
    await res.json();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const rps = Math.round(1000 / avg);

  return {
    avg: Math.round(avg * 1000),
    p50: Math.round(p50 * 1000),
    p95: Math.round(p95 * 1000),
    p99: Math.round(p99 * 1000),
    rps,
  };
}

async function benchSrvx() {
  const server = await serve({
    port: 0,
    silent: true,
    fetch: async (req) => {
      const body = await req.json();
      return new Response(JSON.stringify(body), {
        headers: {
          "x-test": req.headers.get("x-test"),
          "content-type": "application/json",
        },
      });
    },
  });

  await server.ready();
  const result = await measure(server.url, REQUESTS);
  await server.close(true);
  return result;
}

console.log(`\nsrvx hot-path benchmark — ${REQUESTS} sequential requests (${WARMUP} warmup)\n`);
console.log(`Node.js ${process.version} | ${process.platform} ${process.arch}\n`);

const r = await benchSrvx();
console.log(`| avg    | p50    | p95    | p99    | req/s   |`);
console.log(`|--------|--------|--------|--------|---------|`);
console.log(`| ${r.avg}µs | ${r.p50}µs | ${r.p95}µs | ${r.p99}µs | ${r.rps.toLocaleString()}/s |`);
console.log();
