import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { serve, FastResponse } from "../src/adapters/node.ts";

describe("node response stream error handling", () => {
  test("client abort propagates to node readable stream", async () => {
    let onDestroyed!: (v: boolean) => void;
    const destroyed = new Promise<boolean>((r) => (onDestroyed = r));

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            this.push(Buffer.from("x".repeat(1024)));
          },
          destroy(err, cb) {
            onDestroyed(true);
            cb(err);
          },
        });
        return new Response(stream as unknown as ReadableStream);
      },
    });
    await server.ready();

    const controller = new AbortController();
    const res = await fetch(server.url!, { signal: controller.signal });

    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    reader.cancel().catch(() => {});

    const wasDestroyed = await Promise.race([
      destroyed,
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);

    expect(wasDestroyed).toBe(true);
    await server.close(true);
  });

  test("node readable stream error terminates response", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            chunkCount++;
            if (chunkCount <= 2) {
              this.push(Buffer.from("x".repeat(1024)));
            } else {
              process.nextTick(() => this.destroy(new Error("read error")));
            }
          },
        });
        stream.on("error", () => {});
        return new Response(stream as unknown as ReadableStream);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);

    const result = await Promise.race([
      res.text().then(
        () => "completed",
        () => "errored",
      ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);

    expect(result).not.toBe("hung");
    await server.close(true);
  });

  test("web readable stream client abort propagates to cancel", async () => {
    let onCancelled!: (v: boolean) => void;
    const cancelled = new Promise<boolean>((r) => (onCancelled = r));

    const server = serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
            },
            cancel() {
              onCancelled(true);
            },
          }),
        );
      },
    });
    await server.ready();

    const controller = new AbortController();
    const res = await fetch(server.url!, { signal: controller.signal });

    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    reader.cancel().catch(() => {});

    const wasCancelled = await Promise.race([
      cancelled,
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);

    expect(wasCancelled).toBe(true);
    await server.close(true);
  });

  test("web readable stream error terminates response gracefully", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              chunkCount++;
              if (chunkCount <= 2) {
                controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
              } else {
                controller.error(new Error("read error"));
              }
            },
          }),
        );
      },
    });
    await server.ready();

    const result = await fetch(server.url!)
      .then((res) => res.text())
      .then(
        () => "completed",
        () => "errored",
      );

    expect(["completed", "errored"]).toContain(result);
    await server.close(true);
  });

  test("FastResponse: node stream early error returns 500", async () => {
    const server = serve({
      port: 0,
      fetch() {
        // Stream that errors before producing any data
        const stream = new Readable({
          read() {
            process.nextTick(() => this.destroy(new Error("init error")));
          },
        });
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    await server.close(true);
  });

  test("FastResponse: node stream with data pipes correctly", async () => {
    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            this.push(Buffer.from("hello stream"));
            this.push(null);
          },
        });
        return new FastResponse(stream as unknown as BodyInit, {
          status: 201,
          headers: { "x-custom": "test" },
        });
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("test");
    expect(await res.text()).toBe("hello stream");
    await server.close(true);
  });

  test("FastResponse: node stream mid-stream error terminates response", async () => {
    let chunkCount = 0;

    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({
          read() {
            chunkCount++;
            if (chunkCount <= 2) {
              this.push(Buffer.from("x".repeat(1024)));
            } else {
              process.nextTick(() => this.destroy(new Error("mid error")));
            }
          },
        });
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const result = await Promise.race([
      fetch(server.url!)
        .then((res) => res.text())
        .then(
          () => "completed",
          () => "errored",
        ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);

    expect(result).not.toBe("hung");
    await server.close(true);
  });

  test("FastResponse: pre-destroyed node stream returns 500", async () => {
    const server = serve({
      port: 0,
      fetch() {
        const stream = new Readable({ read() {} });
        stream.destroy(new Error("already broken"));
        stream.on("error", () => {});
        return new FastResponse(stream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(500);
    await server.close(true);
  });

  test("duck-typed pipe object (e.g. React PipeableStream) works", async () => {
    const server = serve({
      port: 0,
      fetch() {
        // Simulate React's renderToPipeableStream which returns { pipe, abort }
        const pipeableStream = {
          pipe(writable: NodeJS.WritableStream) {
            writable.write("hello from pipeable");
            writable.end();
            return writable;
          },
          abort() {},
        };
        return new FastResponse(pipeableStream as unknown as BodyInit);
      },
    });
    await server.ready();

    const res = await fetch(server.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from pipeable");
    await server.close(true);
  });
});
