import * as c from "./cli/_utils.ts";
import type { ServerPlugin } from "./types.ts";

export const errorPlugin: ServerPlugin = (server) => {
  const errorHandler = server.options.error;
  if (!errorHandler) return;
  server.options.middleware.unshift((_req, next) => {
    try {
      const res = next();
      return res instanceof Promise ? res.catch((error) => errorHandler(error)) : res;
    } catch (error) {
      return errorHandler(error);
    }
  });
};

export const gracefulShutdownPlugin: ServerPlugin = (server) => {
  const config = server.options?.gracefulShutdown;
  if (
    !globalThis.process?.on ||
    config === false ||
    (config === undefined && (process.env.CI || process.env.TEST))
  ) {
    return;
  }
  const gracefulShutdown =
    config === true || !config?.gracefulTimeout
      ? Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT || "") || 3
      : config.gracefulTimeout;
  const forceShutdown =
    config === true || !config?.forceTimeout
      ? Number.parseInt(process.env.SERVER_FORCE_SHUTDOWN_TIMEOUT || "") || 5
      : config.forceTimeout;
  let isShuttingDown = false;
  let forceClose: (() => void) | undefined;
  const shutdown = async () => {
    if (isShuttingDown) {
      forceClose?.();
      return;
    }
    isShuttingDown = true;
    const w = process.stderr.write.bind(process.stderr);
    w(
      c.gray(
        `\nShutting down server in ${gracefulShutdown}s... (press Ctrl+C again to force close)`,
      ),
    );
    let timeout: any;
    await Promise.race([
      // Graceful shutdown
      server.close().finally(() => {
        clearTimeout(timeout);
        w(c.gray(" Server closed.\n"));
      }),
      new Promise<void>((resolve) => {
        forceClose = () => {
          clearTimeout(timeout);
          w(c.gray("\nForce closing...\n"));
          server.close(true);
          resolve();
        };
        timeout = setTimeout(() => {
          // Graceful shutdown timeout
          w(c.gray(`\nForce closing connections in ${forceShutdown}s...`));
          timeout = setTimeout(() => {
            // Force shutdown timeout
            w(c.red("\nCould not close connections in time, force exiting."));
            resolve();
          }, forceShutdown * 1000);
          return server.close(true);
        }, gracefulShutdown * 1000);
      }),
    ]);
    globalThis.process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    globalThis.process.on(sig, shutdown);
  }
};
