import { Colors as c } from "./_utils.cli.ts";
import type { ServerMiddleware } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LoggingOptions {}

export const log = (_options: LoggingOptions = {}): ServerMiddleware => {
  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    console.log(
      `${c.gray(`[${new Date().toLocaleTimeString()}]`)} ${c.bold(req.method)} ${c.blue(req.url)} [${c[res.ok ? "green" : "red"](res.status + "")}] ${c.gray(`(${duration.toFixed(2)}ms)`)}`,
    );
    return res;
  };
};
