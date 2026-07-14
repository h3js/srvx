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

  let isClosing = false;
  let isClosed = false;
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;

  const w = server.options.silent ? () => {} : process.stderr.write.bind(process.stderr);

  // Remove every listener this plugin registered. Called on all shutdown paths
  // (graceful, forced, timed-out) and on programmatic `close()` so repeated
  // serve()/close() cycles don't accumulate listeners or pin each Server.
  const removeListeners = () => {
    // Cancel the deferred force-close registration so it can't re-add a listener
    // after cleanup has already run.
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
    globalThis.process.removeListener("SIGINT", shutdown);
    globalThis.process.removeListener("SIGTERM", shutdown);
    globalThis.process.removeListener("SIGINT", forceClose);
  };

  const forceClose = async () => {
    if (isClosed) return;
    isClosed = true;
    w(c.red("\x1b[2K\rForcibly closing connections...\n"));
    try {
      await nativeClose(true);
    } catch (error) {
      w(c.red(`\x1b[2K\rError while force closing connections: ${error}\n`));
    } finally {
      removeListeners();
    }
  };

  const shutdown = async () => {
    if (isClosing || isClosed) {
      return;
    }

    // Force close with second Ctrl+C
    // CLIs might trigger multiple SIGINTs, so we delay the listener registration
    forceCloseTimer = setTimeout(() => {
      globalThis.process.once("SIGINT", forceClose);
    }, 100);

    isClosing = true;
    // Never let a rejecting `close()` surface as an unhandledRejection (which
    // would crash the process and skip force-close); capture it and fall through
    // to the force-close path instead.
    let closeError: unknown;
    const closePromise = nativeClose().catch((error) => {
      closeError = error;
    });

    try {
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
        if (closeError) {
          w("\x1b[2K\r" + c.red(`Graceful shutdown failed: ${closeError}\n`));
          await forceClose();
          return;
        }
        if (closed) {
          w("\x1b[2K\r" + c.green("Server closed successfully.\n"));
          isClosed = true;
          return;
        }
      }

      // Graceful period expired: force close
      w("\x1b[2K\rGraceful shutdown timed out.\n");
      await forceClose();
    } finally {
      removeListeners();
    }
  };

  // Wrap `close()` so a programmatic close (no signal) also removes the signal
  // listeners; `nativeClose` is the un-wrapped original used internally to avoid
  // recursion.
  const nativeClose = server.close.bind(server);
  server.close = (closeAll?: boolean) => {
    removeListeners();
    return nativeClose(closeAll);
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    globalThis.process.on(sig, shutdown);
  }
};
