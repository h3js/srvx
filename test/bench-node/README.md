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
Node.js:	 v24.9.0
OS:		 darwin arm64
OHA:		 1.10.0

┌──────────────────┬─────────────────┐
│ node             │ '60997 req/sec' │
│ srvx-fast        │ '56282 req/sec' │
│ hono-fast        │ '55300 req/sec' │
│ whatwg-node-fast │ '52957 req/sec' │
│ srvx             │ '47225 req/sec' │
│ whatwg-node      │ '44670 req/sec' │
│ hono             │ '44138 req/sec' │
│ remix            │ '31529 req/sec' │
└──────────────────┴─────────────────┘
```
