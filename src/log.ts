import { Colors as c } from "./_utils.cli.ts";
import type { ServerMiddleware } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LogOptions {}

const statusColors = { 1: "blue", 2: "green", 3: "yellow" } as Record<
  number,
  "blue" | "green" | "yellow"
>;

export const log = (_options: LogOptions = {}): ServerMiddleware => {
  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;
    const statusColor = statusColors[Math.floor(res.status / 100)] || "red";
    console.log(
      `${c.gray(`[${new Date().toLocaleTimeString()}]`)} ${c.bold(req.method)} ${c.blue(req.url)} [${c[statusColor](res.status + "")}] ${c.gray(`(${duration.toFixed(2)}ms)`)}`,
    );
    return res;
  };
};
