# `srvx/log` Benchmark

Measures the throughput cost of request logging, and how much the current
[`log()`](../../src/log.ts) middleware improves on the previous
`console.log`-per-request implementation.

```sh
pnpm bench:log
```

Requires [`oha`](https://github.com/hatoo/oha) on `PATH`. Tunable via env:
`CONNS` (default 64), `DURATION` (`5sec`), `WARMUP` (`2sec`), `TRIES` (3).

## What it measures

`log()` buffers lines and flushes once per event-loop turn, so many requests
completing in the same turn share a single write. That only pays off under real
concurrency — a single keep-alive connection serialises the requests and hides
it — so the benchmark drives a real server with `oha` at `CONNS` connections
rather than looping in-process.

Each cell is one `(impl, sink)` combination, measured `TRIES` times with the
median reported. The run order is shuffled so machine drift can't systematically
favour one variant.

### `impl` — which logger is installed

| impl     | what it is                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`   | no middleware — the baseline every overhead is measured against                                                                                   |
| `before` | the pre-batching logger (`console.log` per request), vendored verbatim from `src/log.ts` at commit `d2e2b0d` — see [`_before.mjs`](./_before.mjs) |
| `log`    | the current `srvx/log` middleware                                                                                                                 |

### `sink` — where the logged lines go

| sink       | what it represents                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal` | a real TTY: colored output and **synchronous** writes that block on the terminal's rendering. The worst case, and where batching helps most. |
| `pipe`     | streamed to a reader that keeps up (a log collector); no colors                                                                              |
| `devnull`  | discarded — isolates the CPU/formatting cost from any real I/O                                                                               |

The columns:

- **`before Δ` / `log() Δ`** — throughput given up versus `no logger` for that
  sink (the logger's overhead).
- **`log vs before`** — the headline: how much faster the current logger is than
  the old one.

## The `terminal` sink

The child inherits the benchmark's own stdout, so `terminal` runs **only when
`pnpm bench:log` is attached to a terminal** — when its output is piped or
redirected (e.g. CI) there is no TTY to inherit and the sink is skipped.

> **Heads up:** with a terminal, the `before` logger floods it with tens of
> thousands of colored lines per run — that flooding _is_ the thing being
> measured. Its result also depends on your terminal emulator's rendering speed,
> so it is less reproducible than `pipe`/`devnull`. Pipe the output
> (`pnpm bench:log | cat`) to skip it.

## Comparing against an arbitrary revision

`before` is pinned to one commit. To compare `log()` at two _other_ revisions,
run the benchmark on each and diff the `log()` column:

```sh
git stash                 # or: git checkout <base> -- src/log.ts
pnpm bench:log            # "before"
git stash pop             # restore your change
pnpm bench:log            # "after"
```

Keep the machine otherwise idle; run-to-run noise is a few percent.
