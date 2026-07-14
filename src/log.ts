import type { ServerMiddleware } from "./types.ts";

export interface LogOptions {
  /**
   * Sink that receives each formatted log line.
   *
   * @default console.log
   */
  sink?: (line: string) => void;

  /**
   * Emit ANSI colors.
   *
   * Defaults to auto-detection: colors are enabled only when writing to an interactive
   * TTY and the [`NO_COLOR`](https://no-color.org/) convention is not set (`FORCE_COLOR`
   * forces them on). Set explicitly to `true`/`false` to override.
   */
  colors?: boolean;
}

const ansi =
  (open: number, close: number) =>
  (text: string): string =>
    `\u001B[${open}m${text}\u001B[${close}m`;

const identity = (text: string): string => text;

function detectColors(): boolean {
  const proc = globalThis.process;
  const env = proc?.env ?? {};
  if (env.FORCE_COLOR) {
    return true;
  }
  if (env.NO_COLOR || env.TERM === "dumb") {
    return false;
  }
  return !!proc?.stdout?.isTTY;
}

export const log: (options?: LogOptions) => ServerMiddleware = (options = {}) => {
  const sink = options.sink ?? ((line: string) => console.log(line));
  const useColors = options.colors ?? detectColors();

  const bold = useColors ? ansi(1, 22) : identity;
  const red = useColors ? ansi(31, 39) : identity;
  const green = useColors ? ansi(32, 39) : identity;
  const yellow = useColors ? ansi(33, 39) : identity;
  const blue = useColors ? ansi(34, 39) : identity;
  const gray = useColors ? ansi(90, 39) : identity;

  const statusColors = { 1: blue, 2: green, 3: yellow } as const;

  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    const statusColor =
      statusColors[Math.floor(res.status / 100) as unknown as keyof typeof statusColors] || red;
    sink(
      `${gray(`[${new Date().toLocaleTimeString()}]`)} ${bold(req.method)} ${blue(req.url)} [${statusColor(res.status + "")}] ${gray(`(${duration.toFixed(2)}ms)`)}`,
    );
    return res;
  };
};
