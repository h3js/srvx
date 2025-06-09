# Node.js Cmpatibility Benchmarks

Simple benchmarks primarily focus on how closely we can approach native `node:http` performance while using a web standards compatibility layer.

You can locally benchmark by running `pnpm run bench:node --all` in srvx repository.

> [!IMPORTANT]
> Results are **only indicative** of internal optimizations and are almost irrelevant for any real-world usage.

> [!NOTE]
> Variants with `-fast` suffix, use an extended version of built-in `Response` constructor.

> [!TIP]
> Currently `srvx` (with `FastResponse`) can get close to **96.98%** of native `node:http` performance.

```sh
Node.js:         v22.13.0
OS:              darwin arm64
OHA:             1.6.0

┌──────────────────┬──────────────────┐
│ node             │ '100796 req/sec' │
│ srvx-fast        │ '97757 req/sec'  │
│ hono-fast        │ '93141 req/sec'  │
│ whatwg-node-fast │ '84808 req/sec'  │
│ srvx             │ '67125 req/sec'  │
│ whatwg-node      │ '62386 req/sec'  │
│ hono             │ '60502 req/sec'  │
│ remix            │ '30376 req/sec'  │
└──────────────────┴──────────────────┘
```
