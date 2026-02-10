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
  const gracefulTimeout =
    config === true || !config?.gracefulTimeout
      ? Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT || "") || 5
      : config.gracefulTimeout;

  let isShuttingDown = false;

  const w = server.options.silent ? () => {} : process.stderr.write.bind(process.stderr);

  const forceClose = async () => {
    w(c.red("\x1b[2K\rForcibly closing connections...\n"));
    await server.close(true);
    w(c.yellow("Server closed.\n"));
    globalThis.process.exit(0);
  };

  const shutdown = async () => {
    // Second call: force close immediately
    if (isShuttingDown) {
      return forceClose();
    }

    isShuttingDown = true;
    const closePromise = server.close();

    // Countdown with updates each second
    for (let remaining = gracefulTimeout; remaining > 0; remaining--) {
      w(
        c.gray(
          `\rStopping server gracefully (${remaining}s)... Press ${c.bold("Ctrl+C")} again to force close.`,
        ),
      );
      const closed = await Promise.race([
        closePromise.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 1000)),
      ]);
      if (closed) {
        w("\x1b[2K\r" + c.green("Server closed successfully.\n"));
        return;
      }
    }

    // Graceful period expired: force close
    w("\x1b[2K\rGraceful shutdown timed out.\n");
    await forceClose();
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    globalThis.process.on(sig, shutdown);
  }
};
