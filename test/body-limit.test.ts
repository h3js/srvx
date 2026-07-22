import { describe, test, expect } from "vitest";
import { createBodyTooLargeError, limitBodyStream, limitRequestBody } from "../src/body-limit.ts";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("createBodyTooLargeError", () => {
  test("carries the canonical 413 shape", () => {
    const error = createBodyTooLargeError(8);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ERR_BODY_TOO_LARGE");
    expect(error.statusCode).toBe(413);
    expect(error.status).toBe(413);
    expect(error.message).toContain("8");
  });
});

describe("limitBodyStream", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
    return size;
  }

  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  test("passes bodies within the limit through unchanged", async () => {
    const limited = limitBodyStream(streamOf([encode("hi")]), 8);
    expect(await drain(limited)).toBe(2);
  });

  test("errors with a 413 once the limit is exceeded", async () => {
    const limited = limitBodyStream(streamOf([encode("01234"), encode("56789")]), 8);
    await expect(drain(limited)).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });

  test("cancels the upstream stream when the limit is hit", async () => {
    let cancelReason: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode("0123456789"));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    await expect(drain(limitBodyStream(upstream, 8))).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
    });
    expect((cancelReason as any)?.code).toBe("ERR_BODY_TOO_LARGE");
  });

  test("propagates consumer cancellation to the upstream stream", async () => {
    let cancelReason: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode("hi"));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    await limitBodyStream(upstream, 8).cancel("nope");
    expect(cancelReason).toBe("nope");
  });
});

describe("limitRequestBody", () => {
  test("returns a bodyless request unchanged", () => {
    const request = new Request("http://localhost/");
    expect(limitRequestBody(request, 8)).toBe(request);
  });

  test("passes a body within the limit through", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      body: "hi",
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });
    expect(await limitRequestBody(request, 8).text()).toBe("hi");
  });

  test("enforces the streaming limit for chunked bodies (no content-length)", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode("0123456789"));
          controller.close();
        },
      }),
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBe(null);
    await expect(limitRequestBody(request, 8).arrayBuffer()).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
    });
  });

  test("rejects early on an over-limit content-length without reading the body", async () => {
    let pulled = false;
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": "100" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(100));
          controller.close();
        },
      }),
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });
    await expect(limitRequestBody(request, 8).arrayBuffer()).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
      statusCode: 413,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toBe(false);
  });

  test.each(["2.5", "0x9", "Infinity", "abc"])(
    "ignores a malformed content-length %j and enforces via streaming",
    async (contentLength) => {
      const request = new Request("http://localhost/", {
        method: "POST",
        headers: { "content-length": contentLength },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode("hi"));
            controller.close();
          },
        }),
        // @ts-expect-error duplex required for a streaming body
        duplex: "half",
      });
      // Small body within the limit: a false fast-path 413 would break this.
      expect(await limitRequestBody(request, 8).text()).toBe("hi");
    },
  );
});
