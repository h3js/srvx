import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { serve } from "../src/adapters/node.ts";

describe("node response stream error handling", () => {
  test("client abort propagates to node readable stream", async () => {
    const { promise: destroyed, resolve: onDestroyed } =
      Promise.withResolvers<boolean>();

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
    const { promise: cancelled, resolve: onCancelled } =
      Promise.withResolvers<boolean>();

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
                controller.enqueue(
                  new TextEncoder().encode("x".repeat(1024)),
                );
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
});
