// The pre-batching `log()` middleware, reproduced verbatim from `src/log.ts` at
// commit d2e2b0d (the commit before the perf work), so the benchmark compares
// the current logger against the *genuine* previous implementation rather than a
// paraphrase. Two costs it carries that the current logger removes:
//   1. `console.log` once per request — a separate write syscall each time, which
//      is synchronous (and blocks on rendering) when stdout is a terminal.
//   2. `new Date().toLocaleTimeString()` rebuilt every request — Intl-backed.
//
// The color helpers are copied from `src/cli/_utils.ts` at the same commit so
// escape output (and its TTY/NO_COLOR/FORCE_COLOR gating) matches exactly; both
// sides therefore emit identical bytes for a given sink.

const noColor = (() => {
  const proc = globalThis.process;
  const env = proc?.env ?? {};
  if (env.FORCE_COLOR) return false;
  if (env.NO_COLOR || env.TERM === "dumb") return true;
  return !proc?.stdout?.isTTY;
})();

const _c =
  (c, r = 39) =>
  (t) =>
    noColor ? t : `\u001B[${c}m${t}\u001B[${r}m`;

const bold = _c(1, 22);
const red = _c(31);
const green = _c(32);
const yellow = _c(33);
const blue = _c(34);
const gray = _c(90);

const statusColors = { 1: blue, 2: green, 3: yellow };

export const log = () => async (req, next) => {
  const start = performance.now();
  const res = await next();
  const duration = performance.now() - start;
  const statusColor = statusColors[Math.floor(res.status / 100)] || red;
  console.log(
    `${gray(`[${new Date().toLocaleTimeString()}]`)} ${bold(req.method)} ${blue(req.url)} [${statusColor(res.status + "")}] ${gray(`(${duration.toFixed(2)}ms)`)}`,
  );
  return res;
};
