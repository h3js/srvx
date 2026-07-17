# `srvx/log` Benchmark

Measures the throughput cost of the [`log()`](../../src/log.ts) middleware: a
server with no middleware (`no logger`) versus the same server with `log()`,
across the three places logged lines commonly go.

```sh
pnpm bench:log
```

Requires [`oha`](https://github.com/hatoo/oha) on `PATH`. Tunable via env:
`CONNS` (default 64), `DURATION` (`5sec`), `WARMUP` (`2sec`), `TRIES` (3).

## What it measures

`log()` buffers lines and flushes once per event-loop turn, so its cost only
appears under real concurrency — many requests completing in the same turn share
a single write. A single keep-alive connection serialises the requests and hides
this, so the benchmark drives a real server with `oha` at `CONNS` connections
rather than looping in-process.

| sink      | what it represents                                                    |
| --------- | --------------------------------------------------------------------- |
| `devnull` | logs discarded — isolates the formatting/CPU cost from any real I/O    |
| `pipe`    | logs streamed to a reader (a log collector); closest to production    |
| `file`    | logs appended to a file on disk                                       |

`overhead` is the throughput given up by adding the logger, relative to the
no-logger baseline for that same sink. The run order of the cells is shuffled so
machine drift can't systematically favour one variant.

## Reproducing the before/after of a change

This benchmark compares against _no logger_, which is the durable question. To
compare two _implementations_ of `log()` (e.g. before/after a perf change), run
it once on each revision and diff the `log()` column:

```sh
git stash                 # or: git checkout <base> -- src/log.ts
pnpm bench:log            # "before"
git stash pop             # restore your change
pnpm bench:log            # "after"
```

Keep the machine otherwise idle; run-to-run noise is a few percent.
