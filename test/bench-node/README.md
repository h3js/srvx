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
CPU:             AMD Ryzen 9 9950X3D
Node.js:         v24.12.0
OS:              linux x64
OHA:             1.12.0

┌──────────────────┬─────────────────┐
│ node             │ '136396 req/sec' │
│ srvx-fast        │ '123955 req/sec' │
│ whatwg-node-fast │ '113530 req/sec' │
│ srvx             │ '92271 req/sec'  │
│ whatwg-node      │ '83564 req/sec'  │
│ hono-fast        │ '55647 req/sec'  │
│ hono             │ '44563 req/sec'  │
│ remix            │ '41326 req/sec'  │
└──────────────────┴──────────────────┘
```
