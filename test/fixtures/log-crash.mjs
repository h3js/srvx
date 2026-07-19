// Emits three lines through the real `loggerMiddleware()` middleware, then dies according to
// process.argv[2]. `log.test.ts` spawns this and asserts on what reaches the
// pipe: crash-flush behavior only shows in a process that actually terminates.
import { loggerMiddleware } from "../../src/log.ts";

const scenario = process.argv[2];

if (scenario === "once-cleanup") {
  // Registered BEFORE the logger's hook exists: a `once` wrapper removes
  // itself before running, so if the logger's sole-listener check saw the
  // count after that, it would re-raise and kill this cleanup mid-flight.
  process.once("SIGTERM", () => {
    setTimeout(() => {
      process.stdout.write("cleanup done\n");
      process.exit(0);
    }, 50);
  });
}

const middleware = loggerMiddleware();
for (let i = 0; i < 3; i++) {
  await middleware(new Request(`http://localhost/${i}`), () => new Response(""));
}

// The batched flush runs a check phase later, so everything above is still
// buffered at this point.
switch (scenario) {
  case "sighup":
  case "sigterm":
  case "sigint":
  case "once-cleanup": {
    process.kill(process.pid, scenario === "once-cleanup" ? "SIGTERM" : scenario.toUpperCase());
    break;
  }
  case "handled-sigterm": {
    // Another listener owns the shutdown; the logger must not force-kill and
    // the regular flush delivers the lines once the loop drains.
    process.on("SIGTERM", () => {});
    process.kill(process.pid, "SIGTERM");
    break;
  }
  case "exit": {
    // Same-tick `process.exit()`: the `exit` hook flushes synchronously.
    process.exit(0);
  }
  // "natural": fall through and let the event loop drain. Guards against the
  // signal listeners keeping the process alive.
}
