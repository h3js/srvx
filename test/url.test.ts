import net from "node:net";
import { describe, test, expect } from "vitest";
import { FastURL } from "../src/_url.ts";
import { serve } from "../src/adapters/node.ts";
import { NodeRequestURL } from "../src/adapters/_node/url.ts";

const urlTests = await import("./wpt/url_tests.json", {
  with: { type: "json" },
}).then((m) => m.default);

const urlSettersTests = await import("./wpt/url_setters_tests.json", {
  with: { type: "json" },
});

// prettier-ignore
type URLPropName =
"pathname" | "search" | "origin" | "protocol" | "username" |
"password" | "host" | "hostname" | "port" | "hash" | "href"

// prettier-ignore
const urlProps = [
  "pathname", "search", "origin", "protocol", "username",
  "password", "host", "hostname", "port", "hash", "href"
] as URLPropName[];

describe("FastURL", () => {
  test("invalid protocol", () => {
    expect(new FastURL("http:/example.com/foo").pathname).toBe("/foo");
  });

  test("no trailing slash", () => {
    expect(new FastURL("http://example.com").pathname).toBe("/");
  });

  test(".toString() and .toJSON()", () => {
    const url = new FastURL("http://example.com");
    expect(url.toString()).toBe(url.href);
    expect(url.toJSON()).toBe(url.href);
  });

  test(".search (slopw path)", () => {
    const url = new FastURL("http:/example.com/foo?search");
    expect(url.search).toBe("?search");
  });

  test(".searchParams (fast path)", () => {
    const url = new FastURL("http:/example.com/foo?search");
    expect(url.searchParams).toEqual(new URLSearchParams("?search"));
  });

  test(".searchParams (slow path)", () => {
    const url = new FastURL("http:/example.com/foo?search");
    expect(url.href).toBe(url.href); // trigger slow path
    expect(url.searchParams).toEqual(new URLSearchParams("?search"));
  });

  describe("WPT tests", () => {
    for (const t of urlTests) {
      if (typeof t === "string") {
        continue; // Section comment
      }
      if (t.hash || t.href?.endsWith("#")) {
        continue; // Skip tests with hash
      }
      if (!["http:", "https:"].includes(t.protocol!)) {
        continue; // Skip tests with non-http(s) protocols
      }

      // Check if native URL itself passes the test
      let nativePasses = true;
      try {
        const url = new URL(t.input, t.base || undefined);
        for (const prop of urlProps) {
          if (url[prop] !== t[prop]) {
            nativePasses = false;
            break;
          }
        }

        // NOTE: We assume input is already formatted (from incoming HTTP request)
        url.hash = "";
        t.input = url.href;
      } catch {
        nativePasses = false;
      }

      test.skipIf(!nativePasses)(`new FastURL("${t.input}")`, () => {
        const url = new FastURL(t.input);
        for (const prop of urlProps) {
          expect(url[prop], `.${prop}`).toBe(t[prop]);
        }
      });
    }
  });

  describe("setters", async () => {
    for (const [prop, tests] of Object.entries(urlSettersTests)) {
      if (prop === "comment" || prop === "default") continue;
      describe(prop, () => {
        for (const t of tests) {
          const title = `new FastURL("${t.href}").${prop} = "${t.new_value}" ${t.comment ? `// ${t.comment}` : ""}`;

          // Check if native URL itself passes the test
          let nativePasses = true;
          try {
            const url = new URL(t.href);
            url[prop as Exclude<URLPropName, "origin">] = t.new_value;
            for (const [prop, value] of Object.entries(t.expected)) {
              if (url[prop as URLPropName] !== value) {
                nativePasses = false;
                break;
              }
            }
          } catch {
            nativePasses = false;
          }

          test.skipIf(!nativePasses)(title, () => {
            const url = new FastURL(t.href);
            url[prop as Exclude<URLPropName, "origin">] = t.new_value;
            for (const [prop, value] of Object.entries(t.expected)) {
              expect(url[prop as URLPropName], `.${prop}`).toBe(value);
            }
          });
        }
      });
    }
  });

  describe("absolute URI in request line", () => {
    const cases = [
      ["http://example.com/path", "/path"],
      ["http://example.com/path?q=1", "/path"],
      ["file://hehe?/internal/run", "/"],
      ["file://hehe/abc", "/abc"],
      ["http://evil.com?/secret", "/"],
      ["https://host/a/b/c?x=1", "/a/b/c"],
    ] as const;

    for (const [input, expected] of cases) {
      test(`"${input}" => pathname "${expected}"`, () => {
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.pathname).toBe(expected);
      });

      test(`"${input}" => pathname "${expected}" (after deopt)`, () => {
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        // Access hostname to trigger _url deopt
        void url.hostname;
        expect(url.pathname).toBe(expected);
      });
    }
  });

  describe("non-URL request targets (asterisk-form & friends)", () => {
    // RFC 9110 §7.1: the asterisk-form `*` is used for a server-wide
    // OPTIONS request. Surface it as `/*` (matches Deno). Node's HTTP
    // parser also admits `*`-prefixed targets like `**` and `*foo`;
    // these are not valid request-targets and are rejected with 400
    // at the adapter (matches Bun/Deno parser-level rejection).

    test(`"*" synthesizes /*`, () => {
      const fast = new NodeRequestURL({
        req: { url: "*", headers: { host: "localhost" } } as any,
      });
      expect(fast.pathname).toBe("/*");
      expect(fast.search).toBe("");
      expect(fast.href).toBe("http://localhost/*");
    });

    test(`"*" stays consistent after deopt`, () => {
      const slow = new NodeRequestURL({
        req: { url: "*", headers: { host: "localhost" } } as any,
      });
      void slow.hostname; // force deopt to native URL
      expect(slow.hostname).toBe("localhost");
      expect(slow.pathname).toBe("/*");
      expect(slow.search).toBe("");
    });

    async function sendRaw(port: number, requestLine: string) {
      return await new Promise<{ statusLine: string; body: string }>(
        (resolve, reject) => {
          const socket = new net.Socket();
          socket.connect(port, "127.0.0.1", () => {
            socket.write(`${requestLine}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
          });
          let data = "";
          socket.on("data", (chunk) => {
            data += chunk.toString();
          });
          socket.on("end", () => {
            const statusLine = data.split("\r\n")[0] || "";
            const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
            resolve({ statusLine, body });
          });
          socket.on("error", reject);
          socket.setTimeout(2000, () => {
            socket.destroy();
            reject(new Error("socket timed out"));
          });
        },
      );
    }

    async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
      const server = serve({
        port: 0,
        fetch: (request) => new Response(request.url),
      });
      await server.ready();
      const addr = server.node?.server?.address();
      if (!addr || typeof addr !== "object") throw new Error("no address");
      try {
        return await fn(addr.port);
      } finally {
        await server.close(true);
      }
    }

    test("OPTIONS * over the wire returns 200 with href http://host/*", async () => {
      await withServer(async (port) => {
        const result = await sendRaw(port, "OPTIONS * HTTP/1.1");
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 200 /);
        // body may be chunked-encoded
        expect(result.body).toContain("http://localhost/*");
      });
    });

    test.each(["GET ** HTTP/1.1", "GET *foo HTTP/1.1", "GET *?q=1 HTTP/1.1"])(
      "%s over the wire returns 400",
      async (requestLine) => {
        await withServer(async (port) => {
          const result = await sendRaw(port, requestLine);
          expect(result.statusLine).toMatch(/^HTTP\/1\.1 400 /);
        });
      },
    );
  });

  describe("pathname normalization", () => {
    const cases = [
      // Literal dot segments
      ["/foo/../bar/baz", "/bar/baz"],
      ["/foo/./bar", "/foo/bar"],
      ["/a/b/../c/../d", "/a/d"],
      ["/a/b/../../c", "/c"],
      ["/../a", "/a"],
      ["/a/..", "/"],
      ["/a/.", "/a/"],
      ["/a/b/../c?q=1", "/a/c"],
      // Percent-encoded dot segments
      ["/%2e/b", "/b"],
      ["/%2E/b", "/b"],
      ["/%2e%2e/b", "/b"],
      ["/%2E%2E/b", "/b"],
      ["/a/%2e%2e/b", "/b"],
      ["/a/%2e./b", "/b"],
      ["/a/.%2e/b", "/b"],
      ["/a/.%2E/b", "/b"],
      ["/a/%2E./b", "/b"],
      ["/a/%2e", "/a/"],
      ["/a/%2e%2e", "/"],
      // Trailing encoded dot produces trailing slash
      ["/a/b/%2e", "/a/b/"],
      ["/a/b/%2e%2e", "/a/"],
      // Mixed
      ["/a/%2e/../b", "/b"],
      ["/a/./%2e%2e/b", "/b"],
      // Backslash normalization
      ["/a\\b", "/a/b"],
      ["/a\\b\\c", "/a/b/c"],
      ["/a\\b/c", "/a/b/c"],
      // Non-ASCII characters (percent-encoded by native URL)
      ["/caf\u00e9", "/caf%C3%A9"],
      ["/\u00fc\u00f6\u00e4", "/%C3%BC%C3%B6%C3%A4"],
      // Not dot segments (should be untouched)
      ["/a/b/c", "/a/b/c"],
      ["/.hidden", "/.hidden"],
      ["/a/.hidden/b", "/a/.hidden/b"],
    ] as const;

    for (const [input, expected] of cases) {
      test(`native URL: "${input}" => "${expected}"`, () => {
        const url = new URL(`http://localhost${input}`);
        expect(url.pathname).toBe(expected);
      });

      test(`NodeRequestURL: "${input}" => "${expected}"`, () => {
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.pathname).toBe(expected);
      });
    }
  });
});
