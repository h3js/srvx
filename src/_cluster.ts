import nodeCluster from "node:cluster";
import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import * as c from "./cli/_utils.ts";
import { fmtURL, printListening, resolvePortAndHost } from "./_utils.ts";
import type { Server, ServerHandler, ServerOptions } from "./types.ts";

/**
 * Name of the environment variable set in cluster worker processes.
 * The value is the worker index, starting from `"0"`.
 */
export const CLUSTER_WORKER_ENV = "SRVX_CLUSTER_WORKER";

const IS_BUN = !!globalThis.process?.versions?.bun;
const IS_DENO = !!globalThis.process?.versions?.deno;

// Uptime after which a worker is considered stable and its crash counter resets.
const STABLE_UPTIME = 10_000;

// Crash-loop protection: give up if a worker never becomes ready after this many attempts.
const MAX_START_ATTEMPTS = 3;

type ReadyMessage = { srvx?: string; url?: string };

/**
 * Adds cluster (multi-process) support to a runtime adapter's `serve()`.
 *
 * When cluster mode is enabled, the main process becomes a supervisor that only
 * spawns and monitors workers, while worker processes (detected via
 * `SRVX_CLUSTER_WORKER`) serve regularly on the shared port. Otherwise the
 * call passes through to the adapter factory.
 *
 * @param options Server options as passed to `serve()`.
 * @param factory Creates the runtime-specific server instance.
 * @returns The cluster supervisor, or the server created by `factory`.
 */
export function withCluster(
  options: ServerOptions,
  factory: (options: ServerOptions) => Server,
): Server {
  const env = globalThis.process?.env;
  // Loader context (entry is being inspected, server won't listen) or non-process runtime
  if (!env || (globalThis as any).__srvxLoader__) {
    return factory(options);
  }
  // Worker process: start a regular server on the shared port
  if (env[CLUSTER_WORKER_ENV]) {
    // Deno supports SO_REUSEPORT on Linux only (non-Linux runs a single
    // supervised worker that binds the port exclusively).
    const reusePort = !(IS_DENO && process.platform !== "linux");
    const server = factory({ ...options, cluster: false, reusePort, silent: true });
    Promise.resolve(server.ready()).then(
      () => process.send?.({ srvx: "cluster-worker-ready", url: server.url }),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
    return server;
  }
  const workers = resolveClusterSize(options);
  if (workers === undefined) {
    return factory(options);
  }
  return new ClusterServer(options, workers);
}

/**
 * Resolves how many cluster workers should be spawned.
 *
 * An explicit numeric `cluster` option wins over the `SRVX_WORKERS` environment
 * variable, which in turn wins over the CPU core count.
 *
 * @param options Server options as passed to `serve()`.
 * @returns The worker count, or `undefined` when cluster mode is disabled.
 */
function resolveClusterSize(options: ServerOptions): number | undefined {
  if (options.cluster === false || options.cluster === 0) {
    return;
  }
  const envSize = Number.parseInt(globalThis.process?.env?.SRVX_WORKERS || "", 10) || undefined;
  if (!options.cluster && !envSize) {
    return;
  }
  const size =
    typeof options.cluster === "number" ? options.cluster : (envSize ?? availableParallelism());
  return Math.max(1, Math.floor(size));
}

type WorkerState = {
  child: ChildProcess;
  ready: boolean;
  startedAt: number;
};

/**
 * Cluster supervisor implementing the `Server` interface.
 *
 * It never listens itself — it spawns worker processes that serve on the
 * shared port, restarts them when they crash (with exponential backoff) and
 * forwards `SIGINT`/`SIGTERM` for graceful shutdown.
 */
class ClusterServer implements Server {
  readonly runtime = IS_BUN ? "bun" : IS_DENO ? "deno" : "node";
  readonly options: Server["options"];
  readonly fetch: ServerHandler;

  #size: number;
  #workers = new Map<number, WorkerState>();
  #respawnTimers = new Set<ReturnType<typeof setTimeout>>();
  #ready = Promise.withResolvers<void>();
  #url?: string;
  #fallbackURL?: string;
  #started = false;
  #announced = false;
  #closing = false;

  constructor(options: ServerOptions, size: number) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };
    this.fetch = options.fetch;
    this.#size = size;
    this.#ready.promise.catch(() => {}); // avoid unhandled rejection when ready() is not awaited

    if (!process.argv[1]) {
      throw new Error(
        "Cluster mode requires a server entry file (cannot re-execute this process).",
      );
    }
    const { port, hostname } = resolvePortAndHost(options);
    if (!port) {
      throw new Error("Cluster mode requires a fixed port (port: 0 is not supported).");
    }
    const secure = !!(options.tls?.cert || options.protocol === "https");
    this.#fallbackURL = fmtURL(hostname || "localhost", port, secure);

    if (!options.manual) {
      this.serve().catch(() => {});
    }
  }

  /**
   * Spawns all workers (only once) and registers signal forwarding.
   *
   * @returns A promise that resolves once every worker is ready.
   */
  serve(): Promise<this> {
    if (!this.#started) {
      this.#started = true;

      // SO_REUSEPORT load balancing is Linux-only for Bun/Deno: fall back to a
      // single supervised worker instead of spawning processes that would never
      // receive connections (Node uses node:cluster round-robin on all platforms).
      if (process.platform !== "linux" && (IS_BUN || IS_DENO) && this.#size > 1) {
        this.#log(
          c.yellow,
          `Cluster load balancing requires Linux on ${IS_DENO ? "Deno" : "Bun"} (starting 1 worker)`,
        );
        this.#size = 1;
      }

      this.#log(c.gray, `Starting ${this.#size} cluster worker${this.#size > 1 ? "s" : ""}...`);
      for (let slot = 0; slot < this.#size; slot++) {
        this.#spawn(slot, 0);
      }
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, this.#onSignal);
      }
    }
    return this.ready();
  }

  get url(): string | undefined {
    return this.#url || this.#fallbackURL;
  }

  ready(): Promise<this> {
    return this.#ready.promise.then(() => this);
  }

  /**
   * Stops all workers and waits for them to exit.
   *
   * @param closeAll Escalate to `SIGKILL` for workers still alive after 1s.
   */
  async close(closeAll?: boolean): Promise<void> {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.off(signal, this.#onSignal);
    }

    await this.#killAll(closeAll);

    // Unblock pending ready() awaiters: reject when closed before the cluster
    // ever became ready, so callers can tell "listening" from "shut down".
    if (this.#announced) {
      this.#ready.resolve();
    } else {
      this.#ready.reject(new Error("Cluster server closed before becoming ready."));
    }
  }

  /**
   * Sends `SIGTERM` to all live workers and resolves once they exited.
   *
   * @param forceClose `SIGKILL` workers still alive after 1s.
   */
  #killAll(forceClose?: boolean): Promise<void> {
    this.#closing = true;
    this.#clearRespawns();

    const children = [...this.#workers.values()].map((w) => w.child);
    const alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
    const exits = alive.map(
      (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
    );

    for (const child of alive) {
      child.kill("SIGTERM");
    }

    const killTimer = forceClose
      ? setTimeout(() => {
          for (const child of alive) {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }
        }, 1000)
      : undefined;

    killTimer?.unref?.();

    return Promise.all(exits).then(() => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
    });
  }

  /**
   * Starts a worker for the given slot and wires up its readiness and restart handling.
   *
   * @param slot Worker slot index (stable across restarts).
   * @param restarts Consecutive restarts of this slot so far (drives the backoff).
   */
  #spawn(slot: number, restarts: number): void {
    if (this.#closing) {
      return;
    }

    const child = this.#forkWorker(slot);
    const state: WorkerState = { child, ready: false, startedAt: Date.now() };
    this.#workers.set(slot, state);

    child.on("message", (message: ReadyMessage) => {
      if (message?.srvx === "cluster-worker-ready" && !state.ready) {
        state.ready = true;
        this.#url ||= message.url;

        if (!this.#announced && this.#allReady()) {
          this.#announced = true;
          printListening(this.options, this.url);
          this.#ready.resolve();
        }
      }
    });

    child.on("error", (error) => {
      console.error(`Cluster worker ${slot} error:`, error);
    });

    child.on("exit", (code, signal) => {
      if (this.#closing) {
        return;
      }

      this.#workers.delete(slot);

      if (!state.ready && restarts >= MAX_START_ATTEMPTS - 1) {
        const error = new Error(
          `Cluster worker ${slot} failed to start after ${MAX_START_ATTEMPTS} attempts (exited with ${signal || code}).`,
        );

        this.#fatal(error);
        return;
      }

      const uptime = Date.now() - state.startedAt;
      const nextRestarts = uptime > STABLE_UPTIME ? 1 : restarts + 1;
      const delay = Math.min(100 * 2 ** nextRestarts, 30_000);

      this.#log(
        c.yellow,
        `Cluster worker ${slot} exited unexpectedly (${signal || code}), restarting in ${delay}ms...`,
      );

      const timer = setTimeout(() => {
        this.#respawnTimers.delete(timer);
        this.#spawn(slot, nextRestarts);
      }, delay);

      this.#respawnTimers.add(timer);
    });
  }

  /**
   * Forks a worker process that re-executes the current entry.
   *
   * Node workers are created with `node:cluster` so they share the listening
   * handle (round-robin on all platforms). Bun and Deno workers are plain forks
   * that bind the port themselves with `SO_REUSEPORT`.
   *
   * @param slot Worker slot index, exposed to the worker via `SRVX_CLUSTER_WORKER`.
   */
  #forkWorker(slot: number): ChildProcess {
    const workerEnv = { [CLUSTER_WORKER_ENV]: String(slot) };

    if (this.runtime === "node") {
      return nodeCluster.fork(workerEnv).process;
    }

    return fork(process.argv[1], process.argv.slice(2), {
      env: { ...process.env, ...workerEnv },
      // fork's default, passed explicitly: runtime flags like --import must reach the workers
      execArgv: process.execArgv,
    });
  }

  #allReady(): boolean {
    if (this.#workers.size < this.#size) {
      return false;
    }

    for (const worker of this.#workers.values()) {
      if (!worker.ready) {
        return false;
      }
    }

    return true;
  }

  #onSignal = (signal: NodeJS.Signals): void => {
    this.#closing = true;
    this.#clearRespawns();

    for (const { child } of this.#workers.values()) {
      child.kill(signal);
    }
  };

  /**
   * Handles an unrecoverable startup failure: stops all workers and exits with
   * a non-zero code, so process managers (Docker, K8s, ...) see the failed
   * start instead of an idle supervisor.
   */
  #fatal(error: Error): void {
    console.error(c.red(error.message));
    this.#ready.reject(error);
    this.#killAll(true).then(() => process.exit(1));
  }

  #clearRespawns(): void {
    for (const timer of this.#respawnTimers) {
      clearTimeout(timer);
    }

    this.#respawnTimers.clear();
  }

  #log(color: (t: string) => string, message: string): void {
    if (!(this.options.silent ?? globalThis.process?.env?.TEST)) {
      console.log(color(message));
    }
  }
}
