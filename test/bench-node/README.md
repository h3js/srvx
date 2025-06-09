# Node.js compatibility benchmarks

Simple benchmarks primarily focus on how closely we can approach native `node:http` performance while using a web standards compatibility layer.

You can locally benchmark by running `pnpm run bench:node --all` in srvx repository.

> [!IMPORTANT]
> Results are **only indicative** of internal optimizations and are almost irrelevant for any real-world usage.

> [!NOTE]
> Variants with `-fast` suffix, use an extended version of built-in `Response` constructor.

```sh
Node.js:         v22.13.0
OS:              darwin arm64
OHA:             1.6.0


┌──────────────────┬──────────────────┐
│ node             │ '107870 req/sec' │
│ srvx-fast        │ '95622 req/sec'  │
│ hono-fast        │ '93689 req/sec'  │
│ srvx             │ '67793 req/sec'  │
│ whatwg-node      │ '63714 req/sec'  │
│ hono             │ '61511 req/sec'  │
│ remix            │ '30665 req/sec'  │
└──────────────────┴──────────────────┘
```
