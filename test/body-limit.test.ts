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

  test("the limit is inclusive (exactly-at-limit passes, one byte over fails)", async () => {
    // Boundary is `size > max`, so exactly `max` bytes must pass, `max + 1` must fail.
    expect(await drain(limitBodyStream(streamOf([encode("01234567")]), 8))).toBe(8);
    // Accumulated across chunks: 4 + 4 == 8 passes, 4 + 4 + 1 == 9 fails.
    expect(await drain(limitBodyStream(streamOf([encode("0123"), encode("4567")]), 8))).toBe(8);
    await expect(
      drain(limitBodyStream(streamOf([encode("0123"), encode("4567"), encode("8")]), 8)),
    ).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
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
    let cancelReason: unknown;
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": "100" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(100));
          controller.close();
        },
        cancel(reason) {
          cancelReason = reason;
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
    // The original body is cancelled (not read) with the same 413 error.
    expect((cancelReason as any)?.code).toBe("ERR_BODY_TOO_LARGE");
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

  test("reads the limited body via `.body` stream", async () => {
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
    const body = limitRequestBody(request, 8).body!;
    await expect(new Response(body).arrayBuffer()).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
    });
  });

  test("preserves ServerRequest augmentation (runtime, ip, waitUntil, context)", async () => {
    const promises: Promise<unknown>[] = [];
    const request = Object.assign(
      new Request("http://localhost/", {
        method: "POST",
        body: "hi",
        // @ts-expect-error duplex required for a streaming body
        duplex: "half",
      }),
      {
        runtime: { name: "custom" },
        ip: "1.2.3.4",
        context: { user: "alice" },
        waitUntil: (p: Promise<unknown>) => void promises.push(p),
      },
    );

    const limited = limitRequestBody(request, 8);

    // Augmentation passes straight through the proxy...
    expect(limited.runtime).toEqual({ name: "custom" });
    expect(limited.ip).toBe("1.2.3.4");
    expect(limited.context).toEqual({ user: "alice" });
    limited.waitUntil(Promise.resolve());
    expect(promises).toHaveLength(1);

    // ...and it is still the same object, not a rebuilt Request.
    expect(limited).toBeInstanceOf(Request);
    expect(limited.method).toBe("POST");
    expect(limited.url).toBe("http://localhost/");

    // ...while the body is still limited.
    expect(await limited.text()).toBe("hi");
  });

  test("does not rebuild the request (no `new Request`, augmentation kept live)", async () => {
    // A body-bearing object that would throw if passed to `new Request(obj, …)`
    // (mirrors srvx's Node ServerRequest, which is not a native Request).
    const source = new Request("http://localhost/", {
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
    const request = Object.assign(source, { marker: Symbol("keep") });
    const limited = limitRequestBody(request, 8);
    expect(limited.marker).toBe(request.marker);
    await expect(limited.arrayBuffer()).rejects.toMatchObject({
      code: "ERR_BODY_TOO_LARGE",
    });
  });

  const bodyRequest = (body: BodyInit): Request =>
    new Request("http://localhost/", {
      method: "POST",
      body,
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });

  test("content-length exactly at the limit is not rejected by the fast path", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": "8" },
      body: "01234567",
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });
    expect(await limitRequestBody(request, 8).text()).toBe("01234567");
  });

  test.each(["json", "blob", "bytes", "formData", "arrayBuffer"] as const)(
    "enforces the limit through .%s()",
    async (method) => {
      await expect(limitRequestBody(bodyRequest("0123456789"), 8)[method]()).rejects.toMatchObject({
        code: "ERR_BODY_TOO_LARGE",
      });
    },
  );

  test("clone() stays limited (buffered body)", async () => {
    const limited = limitRequestBody(bodyRequest("0123456789"), 8);
    const clone = limited.clone();
    // The clone is independent of the original but still enforces the limit.
    await expect(clone.text()).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
    await expect(limited.text()).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
  });

  test("clone() stays limited (streaming body, cloned before read)", async () => {
    const limited = limitRequestBody(
      bodyRequest(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode("0123456789"));
            controller.close();
          },
        }),
      ),
      8,
    );
    // Clone before touching the body: the underlying stream is tee'd and each
    // branch is re-limited, so both reads still hit the 413.
    const clone = limited.clone();
    await expect(clone.arrayBuffer()).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
    await expect(limited.arrayBuffer()).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
  });

  test("bodyUsed is monotonic (false until read, true after)", async () => {
    const limited = limitRequestBody(bodyRequest("hi"), 8);
    expect(limited.bodyUsed).toBe(false);
    await limited.text();
    expect(limited.bodyUsed).toBe(true);
  });

  test("bodyUsed does not regress on the over-limit fast path", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "0123456789",
      // @ts-expect-error duplex required for a streaming body
      duplex: "half",
    });
    const limited = limitRequestBody(request, 8);
    // The eager cancel must not surface as a spuriously-used body...
    expect(limited.bodyUsed).toBe(false);
    // ...and reading the body (which errors) still marks it used.
    await expect(limited.arrayBuffer()).rejects.toMatchObject({ code: "ERR_BODY_TOO_LARGE" });
    expect(limited.bodyUsed).toBe(true);
  });
});
