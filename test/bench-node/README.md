# Node.js Cmpatibility Benchmarks

Simple benchmarks primarily focus on how closely we can approach native `node:http` performance while using a web standards compatibility layer.

You can locally benchmark by running `pnpm run bench:node --all` in srvx repository.

> [!IMPORTANT]
> Results are **only indicative** of internal optimizations and are almost irrelevant for any real-world usage.

> [!NOTE]
> Variants with `-fast` suffix, use an extended version of built-in `Response` constructor.

> [!TIP]
> Currently `srvx` (with `FastResponse`) can get close to native `node:http` performances.

```sh
Node.js:         v24.10.0
OS:              darwin arm64
OHA:             1.10.0

┌──────────────────┬─────────────────┐
│ node             │ '84114 req/sec' │
│ srvx-fast        │ '75717 req/sec' │
│ whatwg-node-fast │ '71364 req/sec' │
│ srvx             │ '59780 req/sec' │
│ whatwg-node      │ '55774 req/sec' │
│ hono-fast        │ '41972 req/sec' │
│ hono             │ '34807 req/sec' │
│ remix            │ '32693 req/sec' │
└──────────────────┴─────────────────┘
```
