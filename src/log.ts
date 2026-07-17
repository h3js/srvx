import * as c from "./cli/_utils.ts";
import type { ServerMiddleware } from "./types.ts";

export interface LogOptions {}

type Paint = (text: string) => string;

const plain: Paint = (text) => text;

// Indexed by the leading digit of the status: 1xx blue, 2xx green, 3xx yellow,
// anything else (4xx, 5xx and out-of-range codes) red.
const statusColors: readonly Paint[] = [c.red, c.blue, c.green, c.yellow, c.red, c.red];

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
 */
const write: (chunk: string) => void = /* @__PURE__ */ (() => {
  const stdout = globalThis.process?.stdout;
  if (stdout?.write) {
    return (chunk) => void stdout.write(chunk);
  }
  // Chunks always end in a newline, which `console.log` adds back.
  return (chunk) => console.log(chunk.slice(0, -1));
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

function enqueue(line: string): void {
  pending += line;
  if (!scheduled) {
    scheduled = true;
    schedule(flush);
  }
}

function flush(): void {
  scheduled = false;
  const chunk = pending;
  pending = "";
  try {
    write(chunk);
  } catch {
    // A broken stdout (EPIPE, closed worker) must never surface as a request error.
  }
}

/**
 * Whatever is still buffered when the process exits would otherwise be dropped,
 * which typically means the last request before a shutdown. `node:fs` is used
 * directly because `process.stdout.write` is asynchronous for pipes and would
 * not land in time.
 */
let exitHooked = false;
function hookExit(): void {
  const proc = globalThis.process;
  if (exitHooked || !proc?.on) {
    return;
  }
  exitHooked = true;
  proc.on("exit", () => {
    if (!pending) {
      return;
    }
    const chunk = pending;
    pending = "";
    try {
      const fs = proc.getBuiltinModule?.("node:fs");
      if (fs) {
        fs.writeSync(1, chunk);
      } else {
        proc.stdout?.write(chunk);
      }
    } catch {
      // stdout is already gone.
    }
  });
}

export const log: (options?: LogOptions) => ServerMiddleware = (_options = {}) => {
  const colors = colorsEnabled();
  const gray = colors ? c.gray : plain;
  const bold = colors ? c.bold : plain;
  const blue = colors ? c.blue : plain;

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

  // Bounded by the ~60 status codes `Response` accepts, and real traffic reuses
  // a handful of them, so this caches the number-to-string and the escapes.
  const statusCache = new Map<number, string>();
  const status = (code: number): string => {
    let text = statusCache.get(code);
    if (text === undefined) {
      const paint = colors ? (statusColors[(code / 100) | 0] ?? c.red) : plain;
      text = `[${paint(code + "")}]`;
      statusCache.set(code, text);
    }
    return text;
  };

  hookExit();

  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    enqueue(
      `${time()} ${bold(req.method)} ${blue(req.url)} ${status(res.status)} ${gray(`(${duration.toFixed(2)}ms)`)}\n`,
    );
    return res;
  };
};
