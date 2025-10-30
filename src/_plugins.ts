import { Colors } from "./_utils.cli.ts";
import type { ServerPlugin } from "./types.ts";

export const errorPlugin: ServerPlugin = (server) => {
  const errorHandler = server.options.error;
  if (!errorHandler) return;
  server.options.middleware.unshift((_req, next) => {
    try {
      const res = next();
      return res instanceof Promise
        ? res.catch((error) => errorHandler(error))
        : res;
    } catch (error) {
      return errorHandler(error);
    }
  });
};

export const gracefulShutdownPlugin: ServerPlugin = (server) => {
  const config = server.options?.gracefulShutdown;
  if (!globalThis.process?.on || config === false) {
    return;
  }
  const gracefulShutdown =
    config === true || !config?.gracefulTimeout ? 3 : config.gracefulTimeout;
  const forceShutdown =
    config === true || !config?.forceTimeout ? 3 : config.forceTimeout;
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(
      Colors.gray(
        `\nShutting down server... (timeout in ${gracefulShutdown}+${forceShutdown}s)`,
      ),
    );
    let timeout: any;
    await Promise.race([
      // Graceful shutdown
      server.close().finally(() => {
        clearTimeout(timeout);
        console.log(Colors.green("Server closed all connections."));
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          // Graceful shutdown timeout
          console.warn(
            Colors.yellow(
              `Forcing closing connections to exit... (timeout in ${forceShutdown}s)`,
            ),
          );
          timeout = setTimeout(() => {
            // Force shutdown timeout
            console.error(
              Colors.red("Could not close connections in time, force exiting."),
            );
            resolve();
          }, 1000);
          return server.close(true).finally(() => {
            clearTimeout(timeout);
            resolve();
          });
        }, 1000);
      }),
    ]);
    globalThis.process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    globalThis.process.on(sig, shutdown);
  }
};
