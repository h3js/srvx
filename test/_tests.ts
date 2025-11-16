import { describe, expect, test } from "vitest";
import http from "node:http";

export function addTests(opts: {
  url: (path: string) => string;
  runtime: string;
  fetch?: typeof globalThis.fetch;
  http2?: boolean;
}): void {
  const { url, fetch: _fetch = globalThis.fetch } = opts;

  let fetchCount = 0;
  const fetch = (...args: Parameters<typeof _fetch>) => {
    fetchCount++;
    return _fetch(...args);
  };

  test("GET works", async () => {
    const response = await fetch(url("/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch("ok");
  });

  test("request instanceof Request", async () => {
    const response = await fetch(url("/req-instanceof"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      instanceofRequest: "yes",
      instanceofExtended: "no",
    });
  });

  test("extended request instanceof Request", async () => {
    const response = await fetch(url("/extended-req-instanceof"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      instanceofRequest: "yes",
      instanceofExtended: "yes",
    });
  });

  test("request.headers instanceof Headers", async () => {
    const response = await fetch(url("/req-headers-instanceof"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch("yes");
  });

  describe("clone request", () => {
    for (const pathname of ["/req-clone", "/req-new-req"]) {
      test(pathname, async () => {
        const response = await fetch(url(pathname), {
          method: "DELETE",
          headers: { "x-test": "123" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          pathname,
          method: "DELETE",
          headers: { "x-test": "123" },
        });
      });
    }
  });

  test("headers", async () => {
    const response = await fetch(url("/headers"), {
      headers: { foo: "bar", bar: "baz" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      foo: "bar",
      bar: "baz",
      unsetHeader: null,
    });

    expect(response.headers.has("content-type")).toBe(true);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);

    expect(response.headers.get("x-req-foo")).toBe("bar");
    expect(response.headers.get("x-req-bar")).toBe("baz");
  });

  test("response headers mutated", async () => {
    const response = await fetch(url("/headers/response/mutation"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ignored")).toBeNull();

    expect(response.headers.get("x-test-header-1")).toBe("1");
    expect(response.headers.get("x-test-header-2")).toBe("2");
  });

  test("POST works (binary body)", async () => {
    const response = await fetch(url("/body/binary"), {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("POST works (text body)", async () => {
    const response = await fetch(url("/body/text"), {
      method: "POST",
      body: "hello world",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello world");
  });

  test("ip", async () => {
    const response = await fetch(url("/ip"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/ip: ::1|ip: 127.0.0.1/);
  });

  test("runtime agnostic error handler", async () => {
    const response = await fetch(url("/error"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("error: test error");
  });

  test("abort request", async () => {
    const controller = new AbortController();
    const response = await fetch(url("/abort"), {
      signal: controller.signal,
    });
    controller.abort();
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("aborted");

    // Node.js http1 variant needs a bit of time to process the abort
    if (opts.runtime === "node") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const aborts = await fetch(url("/abort-log")).then((res) => res.json());
    const abort = aborts.find((a: any) => a.request === "GET /abort");
    expect(abort).toBeDefined();
    expect(abort.reason).toMatch(/AbortError:|aborted/);
  });

  test("total aborts", async () => {
    let expectedAbortCount = fetchCount;
    if (opts.runtime === "bun") {
      expectedAbortCount = 1; // Bun only aborts explicitly
    }

    const res = await fetch(url("/abort-log"));
    expect(res.status).toBe(200);
    const aborts = await res.json();
    // console.log(aborts.map((a: any) => `${a.request}`).join("\n"));

    // Deno Node.js compat behaves differently!!!
    if (opts.runtime !== "deno-node-compat") {
      expect(aborts.length).toBe(expectedAbortCount);
    }
  });

  // TODO: Investigate writing test for HTTP2/TLS
  test.skipIf(opts.http2)("response stream error", async () => {
    const res = await fetch(url("/response/stream-error"));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader!
        .read()
        .catch(() => ({ done: true, value: undefined }));
      if (value) {
        chunks.push(value);
      }
      if (done) break;
    }
    const body = Buffer.concat(chunks).toString("utf8").trim();
    if ("Bun" in globalThis) {
      // It seems a Bun bug (from fetch client-side not server-side!)
      expect(body).toBe("chunk1\nchunk2\n\r\nchunk1\nchunk2");
    } else {
      expect(body).toBe("chunk1\nchunk2");
    }
  });

  describe("plugin", () => {
    test("intercept before handler", async () => {
      const response = await fetch(url("/"), {
        headers: { "X-plugin-req": "1" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("response from req plugin");
    });

    test("intercept response headers", async () => {
      const response = await fetch(url("/"), {
        headers: { "X-plugin-res": "1" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");

      expect(response.headers.get("x-plugin-header")).toBe("1");
    });
  });

  describe("response types", () => {
    test("ReadableStream", async () => {
      const res = await fetch(url("/response/ReadableStream"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("chunk0\nchunk1\nchunk2\n");
    });

    test("NodeReadable", async () => {
      const res = await fetch(url("/response/NodeReadable"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("chunk0\nchunk1\nchunk2\n");
    });

    test("ArrayBuffer", async () => {
      const res = await fetch(url("/response/ArrayBuffer"));
      expect(res.status).toBe(200);
      expect(await res.text()).toEqual("hello!");
    });

    test("Uint8Array", async () => {
      const res = await fetch(url("/response/Uint8Array"));
      expect(res.status).toBe(200);
      expect(await res.text()).toEqual("hello!");
    });
  });

  describe("response cloning", () => {
    test("clone simple response", async () => {
      const response = await fetch(url("/clone-response"));
      expect(response.status).toBe(200);
    });

    test("clone with headers", async () => {
      const response = await fetch(url("/clone-response"), {
        headers: {
          "x-clone-with-headers": "true",
        },
      });
      expect(response.status).toBe(200);

      expect(response.headers.get("x-clone-with-headers")).toBe("true");
    });
  });

  test("inspect objects", async () => {
    const response = await fetch(url("/node-inspect"), {
      headers: { "x-foo": "1" },
    });
    expect(response.status).toBe(200);
    const data = await response.text();
    expect(data.includes("x-foo"));
  });

  // TODO: Write test to make sure it is forbidden for http2/tls
  test.skipIf(opts.http2)("absolute path in request line", async () => {
    const _url = new URL(url("/"));

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        method: "GET",
        path: _url.href,
        hostname: "localhost",
        port: _url.port,
        headers: { Host: "example.com" },
      });
      req.end();
      req.on("response", resolve);
      req.on("error", reject);
    });
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    expect(res.statusCode).toBe(200);
    expect(body).toBe("ok");
  });
}
