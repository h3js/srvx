import * as c from "./cli/_utils.ts";
import type { ServerMiddleware } from "./types.ts";

export interface LogOptions {}

const statusColors = { 1: c.blue, 2: c.green, 3: c.yellow } as const;

export const log = (_options: LogOptions = {}): ServerMiddleware => {
  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    const statusColor =
      statusColors[Math.floor(res.status / 100) as unknown as keyof typeof statusColors] || c.red;
    console.log(
      `${c.gray(`[${new Date().toLocaleTimeString()}]`)} ${c.bold(req.method)} ${c.blue(req.url)} [${statusColor(res.status + "")}] ${c.gray(`(${duration.toFixed(2)}ms)`)}`,
    );
    return res;
  };
};
