import { describe, expect, test } from "vitest";

export function addTests(
  url: (path: string) => string,
  _opts?: { runtime?: string },
) {
  test("GET works", async () => {
    const response = await fetch(url("/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch("ok");
  });

  test("request instanceof Request", async () => {
    const response = await fetch(url("/req-instanceof"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch("yes");
  });

  test("request.headers instanceof Headers", async () => {
    const response = await fetch(url("/req-headers-instanceof"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch("yes");
  });

  test("headers", async () => {
    const response = await fetch(url("/headers"), {
      headers: { foo: "bar", bar: "baz" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ foo: "bar", bar: "baz" });
    expect(response.headers.get("x-req-foo")).toBe("bar");
    expect(response.headers.get("x-req-bar")).toBe("baz");
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

  test("remoteAddress", async () => {
    const response = await fetch(url("/ip"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/ip: ::1|ip: 127.0.0.1/);
  });

  describe("plugin", () => {
    for (const hook of ["req", "res"]) {
      for (const type of ["async", "sync"]) {
        test(`${type} ${hook}`, async () => {
          const response = await fetch(url("/"), {
            headers: {
              [`x-plugin-${hook}`]: "true",
              [`x-plugin-${type}`]: "true",
            },
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toMatch(`plugin ${hook}`);
        });
      }
    }
  });
}
