import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";
import { gracefulShutdownPlugin } from "../src/_plugins.ts";
import { serve } from "../src/adapters/node.ts";

const fixture = fileURLToPath(new URL("./fixtures/graceful-server.ts", import.meta.url));

function grabShutdownListener(): () => Promise<void> {
  // The plugin registers its `shutdown` handler last, for both SIGINT/SIGTERM.
  const listeners = process.listeners("SIGINT");
  return listeners[listeners.length - 1] as () => Promise<void>;
}

describe("graceful shutdown plugin (in-process)", () => {
  it("closes the server gracefully and removes its signal listeners", async () => {
    const before = {
      int: process.listenerCount("SIGINT"),
      term: process.listenerCount("SIGTERM"),
    };
    const closeCalls: (boolean | undefined)[] = [];
    const server = {
      options: { gracefulShutdown: true, silent: true },
      close: (all?: boolean) => {
        closeCalls.push(all);
        return Promise.resolve();
      },
    } as any;

    gracefulShutdownPlugin(server);
    const shutdown = grabShutdownListener();
    await shutdown();

    // Graceful close (not force), and every listener cleaned up afterwards.
    expect(closeCalls).toEqual([undefined]);
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });

  it("survives a rejecting close() and falls through to force-close", async () => {
    const before = process.listenerCount("SIGINT");
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);

    const closeCalls: (boolean | undefined)[] = [];
    const server = {
      options: { gracefulShutdown: true, silent: true },
      close: (all?: boolean) => {
        closeCalls.push(all);
        // Graceful close rejects; the force close (all === true) succeeds.
        return all ? Promise.resolve() : Promise.reject(new Error("close boom"));
      },
    } as any;

    gracefulShutdownPlugin(server);
    const shutdown = grabShutdownListener();
    await shutdown();
    // Let any stray microtask/unhandledRejection surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onRejection);

    expect(closeCalls).toEqual([undefined, true]); // graceful attempted, then forced
    expect(rejections).toEqual([]); // no unhandledRejection crashed the process
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does not accumulate signal listeners across serve()/close() cycles", async () => {
    const before = {
      int: process.listenerCount("SIGINT"),
      term: process.listenerCount("SIGTERM"),
    };
    for (let i = 0; i < 3; i++) {
      const server = serve({
        port: 0,
        hostname: "localhost",
        gracefulShutdown: true,
        silent: true,
        fetch: () => new Response("ok"),
      });
      await server.ready();
      await server.close();
    }
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });
});

describe("graceful shutdown (child process)", () => {
  it("completes an in-flight request on SIGINT, then exits cleanly", async () => {
    const port = await getRandomPort("localhost");
    const child = execa(process.execPath, [fixture], {
      env: { PORT: String(port), NO_COLOR: "1" },
      reject: false,
    });
    try {
      await waitForPort(port, { host: "localhost", delay: 50, retries: 200 });
      const inflight = fetch(`http://localhost:${port}/slow`);
      // Give the request time to reach the handler before signalling.
      await new Promise((resolve) => setTimeout(resolve, 150));
      child.kill("SIGINT");

      const res = await inflight;
      expect(await res.text()).toBe("slow-done");

      const result = await child;
      expect(result.exitCode).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await child.catch(() => {});
    }
  });

  it("honors gracefulTimeout and force-closes a hung request", async () => {
    const port = await getRandomPort("localhost");
    const child = execa(process.execPath, [fixture], {
      env: { PORT: String(port), GRACEFUL_TIMEOUT: "1", NO_COLOR: "1" },
      reject: false,
    });
    try {
      await waitForPort(port, { host: "localhost", delay: 50, retries: 200 });
      const hung = fetch(`http://localhost:${port}/hang`).catch(() => "aborted");
      await new Promise((resolve) => setTimeout(resolve, 150));

      const start = Date.now();
      child.kill("SIGINT");
      const result = await child;
      const elapsed = Date.now() - start;
      await hung;

      // Exited despite the never-responding request: force close fired after the
      // ~1s graceful window rather than hanging forever.
      expect(result.exitCode).toBe(0);
      expect(elapsed).toBeLessThan(6000);
    } finally {
      child.kill("SIGKILL");
      await child.catch(() => {});
    }
  });
});
