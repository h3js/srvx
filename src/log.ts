import * as c from "./cli/_utils.ts";
import type { ServerMiddleware } from "./types.ts";

export interface LogOptions {
  /**
   * Batch lines and write once per event-loop turn (default: `true`). Set to
   * `false` to hand each line to stdout synchronously: slower under load, but
   * nothing is buffered in the process if it dies before a flush.
   */
  batch?: boolean;
}

type Paint = (text: string) => string;

const plain: Paint = (text) => text;

const paintForStatus = (code: number): Paint =>
  code < 200 ? c.blue : code < 300 ? c.green : code < 400 ? c.yellow : c.red;

/**
 * ANSI escapes are noise once output is piped into a file or a log collector,
 * which is the norm in production. `FORCE_COLOR` still wins, and `cli/_utils.ts`
 * covers the `NO_COLOR` and non-TTY cases on top of this.
 *
 * Resolved per `log()` call rather than at module scope: the CLI assigns
 * `NODE_ENV` while booting, after this module has already been imported.
 */
function colorsEnabled(): boolean {
  const env = globalThis.process?.env;
  return !!env?.FORCE_COLOR || env?.NODE_ENV !== "production";
}

/**
 * Node, Deno and Bun all expose `process.stdout`. Workers have no stdout handle
 * and fall back to `console.log`.
 *
 * `write` returns whether the stream can accept more data right away. A `false`
 * result means the internal buffer is over its high-water mark and `flush` waits
 * for the `drain` event before writing again. `console.log` has no backpressure
 * to report, so it always returns `true`.
 */
const encoder = /* @__PURE__ */ new TextEncoder();
const stdout = globalThis.process?.stdout;
const write: (chunk: string) => boolean = /* @__PURE__ */ (() => {
  if (stdout?.write) {
    return (chunk) => stdout.write(chunk);
  }
  // Chunks always end in a newline, which `console.log` adds back.
  return (chunk) => (console.log(chunk.slice(0, -1)), true);
})();

/**
 * `setImmediate` runs in the check phase of the current event loop turn, so every
 * request that completed during the poll phase shares a single write. That is what
 * keeps the cost down, since `process.stdout` is synchronous for TTYs and regular
 * files. Workers only have `queueMicrotask`, which coalesces within a tick.
 */
const schedule: (task: () => void) => void = /* @__PURE__ */ (() => {
  const setImmediate = globalThis.setImmediate;
  return setImmediate ? (task) => void setImmediate(task) : (task) => queueMicrotask(task);
})();

let pending = "";
let scheduled = false;
let draining = false;

function enqueue(line: string): void {
  pending += line;
  // While the stream is draining we only buffer; `onDrain` reschedules the flush.
  if (!scheduled && !draining) {
    scheduled = true;
    schedule(flush);
  }
}

/**
 * Unbatched mode (`batch: false`): append and flush in the same call, so the
 * line is handed to stdout before the request completes. It still goes through
 * `pending` + `flush` rather than `write` directly, so it can never overtake
 * lines a batched logger or a drain wait is still holding.
 */
function writeNow(line: string): void {
  pending += line;
  if (!draining) {
    flush();
  }
}

function flush(): void {
  scheduled = false;
  // `draining` is never true here: `enqueue` won't schedule a flush and
  // `writeNow` won't call one while draining; `onDrain` clears it first.
  if (!pending) {
    return;
  }
  const chunk = pending;
  pending = "";
  try {
    if (!write(chunk) && stdout?.once) {
      // Buffer is over the high-water mark: stop feeding the stream until it
      // drains rather than piling more onto an already-full stdout. Lines keep
      // accumulating in `pending` meanwhile; `onDrain` resumes the flush.
      draining = true;
      stdout.once("drain", onDrain);
    }
  } catch {
    // A broken stdout (EPIPE, closed worker) must never surface as a request error.
  }
}

function onDrain(): void {
  draining = false;
  if (pending) {
    scheduled = true;
    schedule(flush);
  }
}

/**
 * Whatever is still buffered when the process exits would otherwise be dropped,
 * which typically means the last request before a shutdown. `node:fs` is used
 * directly because `process.stdout.write` is asynchronous for pipes and would
 * not land in time.
 */
function flushSync(): void {
  if (!pending) {
    return;
  }
  const proc = globalThis.process;
  const chunk = pending;
  pending = "";
  try {
    const fs = proc?.getBuiltinModule?.("node:fs");
    if (fs) {
      // Encode with the web-standard `TextEncoder` so this stays runtime
      // agnostic (`Buffer` is Node-only); `writeSync` takes any typed array.
      // A `writeSync` may accept only part of the bytes, so advance by the
      // returned count until the whole chunk lands.
      const bytes = encoder.encode(chunk);
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(1, bytes, offset, bytes.length - offset);
        if (written <= 0) {
          break;
        }
        offset += written;
      }
    } else {
      proc?.stdout?.write(chunk);
    }
  } catch {
    // stdout is already gone.
  }
}

let exitHooked = false;
function hookExit(): void {
  const proc = globalThis.process;
  if (exitHooked || !proc?.on) {
    return;
  }
  exitHooked = true;
  proc.on("exit", flushSync);

  // A default-handled SIGTERM/SIGINT terminates the process without emitting
  // `exit`, silently dropping whatever is buffered. That only happens when no
  // listener exists at all — srvx's graceful shutdown normally registers one —
  // so a listener is installed per signal that, when it turns out to be the
  // only one, flushes and re-raises with the default disposition restored:
  // the process still dies by the signal, with `exit` semantics untouched.
  if (!proc.listenerCount || !proc.kill) {
    return;
  }
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const onSignal = (): void => {
      // Another listener owns the shutdown (e.g. graceful shutdown): the
      // process keeps running and the regular flush path delivers `pending`.
      // Flushing here would jump ahead of anything the stream has queued.
      if (proc.listenerCount(sig) > 1) {
        return;
      }
      flushSync();
      proc.removeListener(sig, onSignal);
      try {
        proc.kill(proc.pid, sig);
      } catch {
        // Re-raising is unsupported (e.g. Windows edge cases): exit with the
        // conventional 128 + signal number code instead of hanging alive.
        proc.exit(sig === "SIGINT" ? 130 : 143);
      }
    };
    proc.on(sig, onSignal);
  }
}

export const log: (options?: LogOptions) => ServerMiddleware = (options = {}) => {
  const emit = options.batch === false ? writeNow : enqueue;
  const colors = colorsEnabled();
  const paint = (fn: Paint): Paint => (colors ? fn : plain);
  const gray = paint(c.gray);
  const bold = paint(c.bold);
  const blue = paint(c.blue);

  // `toLocaleTimeString()` is Intl-backed and costs more than the rest of the
  // line put together, yet its second-resolution output only changes once a
  // second — two timestamps in the same second always format identically.
  let cachedSecond = 0;
  let cachedTime = "";
  const time = (): string => {
    const now = Date.now();
    const second = now - (now % 1000);
    if (second !== cachedSecond) {
      cachedSecond = second;
      cachedTime = gray(`[${new Date(now).toLocaleTimeString()}]`);
    }
    return cachedTime;
  };

  const status = (code: number): string => `[${paint(paintForStatus(code))(code + "")}]`;

  hookExit();

  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    emit(
      `${time()} ${bold(req.method)} ${blue(req.url)} ${status(res.status)} ${gray(`(${duration.toFixed(2)}ms)`)}\n`,
    );
    return res;
  };
};
