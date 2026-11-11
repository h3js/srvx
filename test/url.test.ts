import net from "node:net";
import { describe, test, expect, vi } from "vitest";
import { FastURL } from "../src/_url.ts";
import { serve } from "../src/adapters/node.ts";
import { hasAmbiguousPath, NodeRequestURL } from "../src/adapters/_node/url.ts";
import { isValidHost } from "../src/_trust-proxy.ts";
import { HOST_PARSER_AGREEMENT_CASES } from "./_utils.ts";

const urlTests = await import("./wpt/url_tests.json", {
  with: { type: "json" },
}).then((m) => m.default);

const urlSettersTests = await import("./wpt/url_setters_tests.json", {
  with: { type: "json" },
});

// prettier-ignore
type URLPropName =
"pathname" | "search" | "origin" | "protocol" | "username" |
"password" | "host" | "hostname" | "port" | "hash" | "href";

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

  describe("searchParams identity & mutation", () => {
    // Native URL hands out the SAME `searchParams` object for the lifetime of
    // the URL, and mutations are reflected in `search`/`href`. The fast path
    // used to hand out a detached URLSearchParams whose identity broke on any
    // deopt (even a read-only `url.host` access) and whose mutations were
    // silently discarded. The facade (with `_adopt`, mirroring
    // NodeRequestHeaders) must close both gaps.

    test("same object across a read-only deopt", () => {
      const url = new FastURL("/p?a=1");
      const params = url.searchParams;
      void url.hostname; // deopt to native URL
      expect(url.searchParams).toBe(params);
      expect(params.get("a")).toBe("1");
    });

    test("instanceof URLSearchParams, iterable, and copyable", () => {
      const url = new FastURL("/p?a=1&b=2");
      const params = url.searchParams;
      expect(params instanceof URLSearchParams).toBe(true);
      expect([...params]).toEqual([
        ["a", "1"],
        ["b", "2"],
      ]);
      expect(new URLSearchParams(params as any).toString()).toBe("a=1&b=2");
      expect(params.size).toBe(2);
      expect(params.getAll("a")).toEqual(["1"]);
      expect(params.toString()).toBe("a=1&b=2");
    });

    test("set/append/delete/sort are reflected in search & href (like native)", () => {
      const std = new URL("http://localhost/p?b=2&a=1");
      const url = new FastURL("/p?b=2&a=1");
      for (const u of [std, url]) {
        u.searchParams.set("c", "3");
        u.searchParams.append("a", "x");
        u.searchParams.delete("b");
        u.searchParams.sort();
      }
      expect(url.search, ".search").toBe(std.search);
      expect(url.href, ".href").toBe(std.href);
      expect(url.searchParams.toString()).toBe(std.searchParams.toString());
    });

    test("reference taken before deopt observes later URL mutations", () => {
      const url = new FastURL("/p?a=1");
      const params = url.searchParams;
      url.search = "?z=9"; // setter deopts and mutates the native URL
      expect(params.get("z")).toBe("9");
      expect(params.get("a")).toBe(null);
      expect(url.searchParams).toBe(params);
    });

    test("mutation on the fast path deopts and drops cached search", () => {
      const url = new FastURL("/p?a=1");
      expect(url.search).toBe("?a=1"); // populate fast-path cache first
      url.searchParams.delete("a");
      expect(url.search).toBe("");
      expect(url.href).toBe("http://localhost/p");
    });

    test("constructor slow path keeps stable native searchParams", () => {
      const url = new FastURL("http://example.com/p?a=1");
      const params = url.searchParams;
      expect(url.searchParams).toBe(params);
      params.set("b", "2");
      expect(url.search).toBe("?a=1&b=2");
    });

    test("read-then-mutate: detached read cache is discarded on adoption", () => {
      const url = new FastURL("/p?a=1");
      const params = url.searchParams;
      expect(params.get("a")).toBe("1"); // populate the lazily-parsed read store
      params.set("b", "2"); // adopts the native URL's params; read store discarded
      expect(url.search).toBe("?a=1&b=2");
      expect(url.href).toBe("http://localhost/p?a=1&b=2");
      expect(params.get("b")).toBe("2");
    });

    test("encoding round-trip matches native (%2B, +, %20)", () => {
      const input = "/p?a=%2B&b=+&c=%20";
      const std = new URL(`http://localhost${input}`);
      const url = new FastURL(input);
      expect(url.searchParams.get("a")).toBe(std.searchParams.get("a")); // "+"
      expect(url.searchParams.get("b")).toBe(std.searchParams.get("b")); // " "
      expect(url.searchParams.get("c")).toBe(std.searchParams.get("c")); // " "
      for (const u of [std, url]) {
        u.searchParams.set("d", "+ &=");
      }
      expect(url.search).toBe(std.search);
      expect(url.href).toBe(std.href);
    });

    test("forEach forwards thisArg", () => {
      const url = new FastURL("/p?a=1&b=2");
      const thisArg = { tag: "ctx" };
      const seen: [string, string, unknown][] = [];
      url.searchParams.forEach(function (this: unknown, value, key) {
        seen.push([key, value, this]);
      }, thisArg);
      expect(seen).toEqual([
        ["a", "1", thisArg],
        ["b", "2", thisArg],
      ]);
    });

    test("delete/has with value argument match native", () => {
      const std = new URL("http://localhost/p?a=1&a=2&b=3");
      const url = new FastURL("/p?a=1&a=2&b=3");
      expect(url.searchParams.has("a", "2")).toBe(true);
      expect(url.searchParams.has("a", "9")).toBe(false);
      for (const u of [std, url]) {
        u.searchParams.delete("a", "1");
      }
      expect(url.search).toBe(std.search);
      for (const u of [std, url]) {
        u.searchParams.delete("b");
      }
      expect(url.search).toBe(std.search);
      expect(url.href).toBe(std.href);
    });

    test("NodeRequestURL: mutation reflected, raw req.url untouched", () => {
      const req = { url: "/p?a=1", headers: { host: "localhost" } } as any;
      const url = new NodeRequestURL({ req });
      url.searchParams.set("b", "2");
      expect(url.href).toBe("http://localhost/p?a=1&b=2");
      expect(url.searchParams).toBe(url.searchParams);
      expect(req.url).toBe("/p?a=1");
    });
  });

  describe("origin-form string (bare path)", () => {
    // Regression (F12): `new FastURL("/foo?x=1")` is a documented fast path.
    // It must resolve against `http://localhost` semantics (like the adapter's
    // URLInit path) instead of deopting to `new URL("/foo?x=1")` with no base,
    // which throws `TypeError: Invalid URL`. Getters must match native both
    // before and after a mutation-triggered deopt.
    const cases = ["/foo?x=1", "/", "/a/b/c", "/p?a=1&b=2", "/only-path"] as const;

    for (const input of cases) {
      test(`FastURL "${input}" matches native`, () => {
        const std = new URL(`http://localhost${input}`);
        const url = new FastURL(input);
        expect(url.pathname, ".pathname").toBe(std.pathname);
        expect(url.search, ".search").toBe(std.search);
        expect(url.searchParams.toString(), ".searchParams").toBe(std.searchParams.toString());
        expect(url.href, ".href").toBe(std.href);
      });

      test(`FastURL "${input}" stays consistent after deopt`, () => {
        const std = new URL(`http://localhost${input}`);
        const url = new FastURL(input);
        void url.hostname; // force deopt to native URL
        expect(url.hostname, ".hostname").toBe("localhost");
        expect(url.pathname, ".pathname").toBe(std.pathname);
        expect(url.search, ".search").toBe(std.search);
        expect(url.href, ".href").toBe(std.href);
      });
    }

    // The origin-form string fast path must apply the same path checks as the
    // `URLInit` path (dot segments, `\`, path percent-encode set), not just the
    // query set, and must split off the query before matching dot segments.
    const needsNorm = [
      "/a/../b",
      "/a/..",
      "/a/.",
      "/../../etc/passwd",
      "/files/../../../secret.env",
      "/a/%2e%2e/b",
      "/a/.%2E/b",
      "/a/..?x=1",
      "/a/.?x=1",
      "/a\\b",
      "/a^b",
      "/a{b}",
      "/a`b",
      "/a?b='x'",
      '/a?b="x"',
    ] as const;

    for (const input of needsNorm) {
      test(`FastURL ${JSON.stringify(input)} normalizes like native`, () => {
        const std = new URL(`http://localhost${input}`);
        const url = new FastURL(input);
        expect(url.pathname, ".pathname").toBe(std.pathname);
        expect(url.search, ".search").toBe(std.search);
        expect(url.href, ".href").toBe(std.href);
      });
    }

    // Path-set chars and dot segments in the query stay verbatim there
    // (native leaves them raw too), so they must not change `search`.
    test("path-set chars and dot segments in the query match native", () => {
      for (const input of ["/p?a=^", "/p?a={b}", "/p?a=`", "/p?a=\\b", "/p?a=..", "/p?a=/../"]) {
        const std = new URL(`http://localhost${input}`);
        const url = new FastURL(input);
        expect(url.pathname, `${input} .pathname`).toBe(std.pathname);
        expect(url.search, `${input} .search`).toBe(std.search);
        expect(url.href, `${input} .href`).toBe(std.href);
      }
    });

    // Guard against over-deopting: canonical targets stay on the fast path,
    // which never reads the native `pathname`/`search` getters.
    test("canonical targets stay on the fast path", () => {
      const pathname = vi.spyOn(URL.prototype, "pathname", "get");
      const search = vi.spyOn(URL.prototype, "search", "get");
      try {
        for (const input of [
          "/",
          "/api/users/123?x=1",
          "/a.b/c.d?x=1&y=2",
          "/.well-known/x",
          "/a/...",
          "/a?",
          "/path%20with%20space",
        ]) {
          const url = new FastURL(input);
          void url.pathname;
          void url.search;
          expect(pathname, input).not.toHaveBeenCalled();
          expect(search, input).not.toHaveBeenCalled();
        }
        // Sanity: a deopted target does hit the native getters.
        void new FastURL("/a/../b").pathname;
        expect(pathname).toHaveBeenCalled();
      } finally {
        pathname.mockRestore();
        search.mockRestore();
      }
    });
  });

  describe("HTTP/2-reachable chars (control, space, DEL, non-ASCII)", () => {
    // Regression (F33): the normalization regexes assumed control chars and
    // space are rejected by the HTTP parser — true for HTTP/1, FALSE over
    // HTTP/2 which the Node adapter serves. A raw `:path` like `/p?q=é` reaches
    // the handler verbatim; native URL percent-encodes/strips these, so the
    // fast path must deopt to match — both before and after a later deopt.
    const chars = {
      "é (non-ASCII)": "é",
      "DEL (\\x7f)": "\x7f",
      space: " ",
    };

    for (const [name, ch] of Object.entries(chars)) {
      for (const input of [`/a${ch}b`, `/p?x=${ch}y`]) {
        test(`FastURL string ${name} in "${JSON.stringify(input)}" matches native`, () => {
          const std = new URL(`http://localhost${input}`);
          // sanity: native did rewrite the raw char
          expect(std.href).not.toBe(`http://localhost${input}`);

          const url = new FastURL(input);
          expect(url.pathname, ".pathname").toBe(std.pathname);
          expect(url.search, ".search").toBe(std.search);
          expect(url.href, ".href").toBe(std.href);
          expect(url.searchParams.toString(), ".searchParams").toBe(std.searchParams.toString());
        });

        test(`NodeRequestURL ${name} in "${JSON.stringify(input)}" matches native (before & after deopt)`, () => {
          const std = new URL(`http://localhost${input}`);
          const url = new NodeRequestURL({
            req: { url: input, headers: { host: "localhost" } } as any,
          });
          expect(url.pathname, ".pathname").toBe(std.pathname);
          expect(url.search, ".search").toBe(std.search);
          expect(url.href, ".href").toBe(std.href);
          void url.hostname; // force deopt to native URL
          expect(url.pathname, ".pathname (deopt)").toBe(std.pathname);
          expect(url.search, ".search (deopt)").toBe(std.search);
          expect(url.href, ".href (deopt)").toBe(std.href);
        });
      }
    }
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

  describe("Host header validation", () => {
    // `request.url` must always be parseable: a host the WHATWG parser rejects
    // (port > 65535, invalid IPv4/IPv6, numeric last label) becomes `_invalid_`
    // instead of making `new URL()` / the native Request throw downstream (500).
    const cases = [
      // [Host, expected URL host]
      ["localhost:0", "localhost:0"],
      ["localhost:65535", "localhost:65535"],
      ["localhost:080", "localhost"],
      ["localhost:00080", "localhost"],
      ["localhost:08080", "localhost:8080"],
      ["127.0.0.1:3000", "127.0.0.1:3000"],
      ["255.255.255.255", "255.255.255.255"],
      ["01.02.03.04", "1.2.3.4"],
      ["1.2.3", "1.2.0.3"],
      ["0x7f.1", "127.0.0.1"],
      ["foo.0xg", "foo.0xg"],
      ["web1.example", "web1.example"],
      ["[::1]:3000", "[::1]:3000"],
      // out-of-range port
      ["localhost:65536", "_invalid_"],
      ["localhost:65540", "_invalid_"],
      ["localhost:65600", "_invalid_"],
      ["localhost:66000", "_invalid_"],
      ["localhost:70000", "_invalid_"],
      ["localhost:99999", "_invalid_"],
      ["127.0.0.1:99999", "_invalid_"],
      ["[::1]:99999", "_invalid_"],
      // passes `HOST_RE`, rejected by the WHATWG parser
      ["256.0.0.1", "_invalid_"],
      ["999.999.999.999", "_invalid_"],
      ["foo.123", "_invalid_"],
      ["a.09", "_invalid_"],
      ["foo.0x", "_invalid_"],
      ["foo.0x1:3000", "_invalid_"],
      ["99999999999", "_invalid_"],
      ["[::::]", "_invalid_"],
      ["[1.2.3]", "_invalid_"],
    ] as const;

    for (const [host, expected] of cases) {
      test(`Host: ${host} => ${expected}`, () => {
        expect(isValidHost(host), "isValidHost").toBe(expected !== "_invalid_");
        const url = new NodeRequestURL({ req: { url: "/x", headers: { host } } as any });
        expect(new URL(url.href).host).toBe(expected);
        void url.hostname; // deopt
        expect(url.host).toBe(expected);
      });
    }

    // Runtimes disagree on some hosts (Bun/Deno reject invalid punycode such
    // as `xn--a`, Bun rejects `42949672950x`; Node accepts both), so
    // `isValidHost` defers to the current runtime's parser.
    test.each(HOST_PARSER_AGREEMENT_CASES)("isValidHost(%j) agrees with URL.canParse", (host) => {
      expect(isValidHost(host)).toBe(URL.canParse(`http://${host}`));
      // a second call is answered from the one-entry cache
      expect(isValidHost(host)).toBe(URL.canParse(`http://${host}`));
    });
  });

  describe("absolute URI in request line", () => {
    // RFC 9112 §3.2.2 requires accepting absolute-form and §3.3 makes its
    // authority supersede `Host` — but srvx is an origin server, not a proxy, so
    // the target is rebuilt rather than trusted verbatim:
    //  - the scheme always comes from the transport (a client must never be able
    //    to claim `https:` on a plaintext socket),
    //  - the authority goes through `HOST_RE` exactly like a `Host` header
    //    (`_invalid_` on failure),
    //  - userinfo is dropped (`new Request()` throws on credentials → 500).
    // Asserting only `pathname` is what let this slip through, so every case
    // pins href/protocol/host/username.
    const cases = [
      // [input, pathname, href]
      ["http://example.com/path", "/path", "http://example.com/path"],
      ["http://example.com/path?q=1", "/path", "http://example.com/path?q=1"],
      ["file://hehe?/internal/run", "/", "http://hehe/?/internal/run"],
      ["file://hehe/abc", "/abc", "http://hehe/abc"],
      ["http://evil.com?/secret", "/", "http://evil.com/?/secret"],
      ["https://host/a/b/c?x=1", "/a/b/c", "http://host/a/b/c?x=1"],
      // scheme is transport-derived, never client-derived
      ["https://evil.com/x", "/x", "http://evil.com/x"],
      ["HTTPS://EVIL.example.com/x", "/x", "http://evil.example.com/x"],
      // userinfo is dropped
      ["http://evil.com@real.example/admin", "/admin", "http://real.example/admin"],
      ["http://user:pass@real.example/admin", "/admin", "http://real.example/admin"],
      // HOST_RE-invalid authority -> `_invalid_` (same convention as `Host`)
      ["http://evil.com./x", "/x", "http://_invalid_/x"],
      ["http://evil.com.:8080/x", "/x", "http://_invalid_/x"],
      // authority-less / unparseable targets keep the validated `Host`
      ["file:///etc/passwd", "/etc/passwd", "http://localhost/etc/passwd"],
      ["http://evil.com:99999/x", "/", "http://localhost/"],
      ["http://[bad]/x", "/", "http://localhost/"],
      // an explicit non-default port survives (it passes HOST_RE)
      ["http://evil.com:8080/x", "/x", "http://evil.com:8080/x"],
      // dot segments are normalized by the WHATWG parse
      ["http://example.com/a/../b", "/b", "http://example.com/b"],
    ] as const;

    for (const [input, expected, href] of cases) {
      const expectedURL = new URL(href);

      test(`"${input}" => "${href}"`, () => {
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.pathname, ".pathname").toBe(expected);
        expect(url.protocol, ".protocol").toBe("http:");
        expect(url.host, ".host").toBe(expectedURL.host);
        expect(url.origin, ".origin").toBe(expectedURL.origin);
        expect(url.username, ".username").toBe("");
        expect(url.password, ".password").toBe("");
        expect(url.href, ".href").toBe(href);
      });

      test(`"${input}" => "${href}" (after deopt)`, () => {
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        // Access hostname to trigger _url deopt
        void url.hostname;
        expect(url.pathname, ".pathname").toBe(expected);
        expect(url.protocol, ".protocol").toBe("http:");
        expect(url.host, ".host").toBe(expectedURL.host);
        expect(url.origin, ".origin").toBe(expectedURL.origin);
        expect(url.username, ".username").toBe("");
        expect(url.password, ".password").toBe("");
        expect(url.href, ".href").toBe(href);
      });
    }

    test("an encrypted socket keeps https: for an http: absolute-form target", () => {
      const req = {
        url: "http://evil.com/x",
        headers: { host: "localhost" },
        socket: { encrypted: true },
      } as any;
      expect(new NodeRequestURL({ req }).href).toBe("https://evil.com/x");
      const deopt = new NodeRequestURL({ req });
      void deopt.hostname;
      expect(deopt.href).toBe("https://evil.com/x");
    });

    test("untrusted x-forwarded-* cannot change an absolute-form target", () => {
      const req = {
        url: "http://evil.com/x",
        headers: {
          host: "localhost",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "forwarded.example",
        },
      } as any;
      // hops = 0 (trustProxy: false)
      expect(new NodeRequestURL({ req }).href).toBe("http://evil.com/x");
      // a trusted hop may set the scheme, but never via the request line
      expect(new NodeRequestURL({ req, hops: 1 }).href).toBe("https://evil.com/x");
    });
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
      return await new Promise<{ statusLine: string; body: string }>((resolve, reject) => {
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
      });
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

    // llhttp delivers any hierarchical `scheme://...` absolute-form target.
    // srvx is an origin server for http(s) only (RFC 9110 §7.4).
    test.each([
      "GET file:///etc/passwd HTTP/1.1",
      "GET file://hehe/x HTTP/1.1",
      "GET ftp://evil.com/ HTTP/1.1",
      "GET zzz://evil/x HTTP/1.1",
      "GET http:// HTTP/1.1",
      "GET http://evil.com:99999/x HTTP/1.1",
    ])("%s over the wire returns 400", async (requestLine) => {
      await withServer(async (port) => {
        const result = await sendRaw(port, requestLine);
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 400 /);
      });
    });

    test("http(s) absolute-form is accepted, with the transport scheme", async () => {
      await withServer(async (port) => {
        const ok = await sendRaw(port, "GET http://evil.com/x HTTP/1.1");
        expect(ok.statusLine).toMatch(/^HTTP\/1\.1 200 /);
        expect(ok.body).toContain("http://evil.com/x");

        // `https:` on a plaintext socket must not survive.
        const spoofed = await sendRaw(port, "GET https://evil.com/x HTTP/1.1");
        expect(spoofed.statusLine).toMatch(/^HTTP\/1\.1 200 /);
        expect(spoofed.body).toContain("http://evil.com/x");
        expect(spoofed.body).not.toContain("https://");
      });
    });

    // Raw `\` before the query: see `hasAmbiguousPath`.
    test.each([
      String.raw`GET /public\..\admin/secret HTTP/1.1`,
      String.raw`GET /public\admin HTTP/1.1`,
      String.raw`GET /a\b?q=1 HTTP/1.1`,
      String.raw`GET http://localhost/public\..\admin/secret HTTP/1.1`,
      String.raw`GET http:\\localhost\admin HTTP/1.1`,
    ])("%s over the wire returns 400", async (requestLine) => {
      await withServer(async (port) => {
        const result = await sendRaw(port, requestLine);
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 400 /);
      });
    });

    test.each([
      ["GET /a%5Cb HTTP/1.1", "http://localhost/a%5Cb"],
      [String.raw`GET /x?q=\a HTTP/1.1`, String.raw`http://localhost/x?q=\a`],
      [String.raw`GET http://localhost/x?q=\a HTTP/1.1`, String.raw`http://localhost/x?q=\a`],
    ])("%s (encoded or query backslash) is accepted", async (requestLine, href) => {
      await withServer(async (port) => {
        const result = await sendRaw(port, requestLine);
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 200 /);
        expect(result.body).toContain(href);
      });
    });

    // A complete `.` / `..` segment before the query: see `hasAmbiguousPath`
    // (the full table is in the `hasAmbiguousPath` tests below).
    test.each([
      "GET /public/../admin/secret HTTP/1.1",
      "GET /public/%2e%2e/admin/secret HTTP/1.1",
      "GET http://localhost/public/../admin/secret HTTP/1.1",
    ])("%s over the wire returns 400", async (requestLine) => {
      await withServer(async (port) => {
        const result = await sendRaw(port, requestLine);
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 400 /);
      });
    });

    test.each([
      ["GET /.well-known/x HTTP/1.1", "http://localhost/.well-known/x"],
      ["GET /x?p=/../a HTTP/1.1", "http://localhost/x?p=/../a"],
      ["OPTIONS * HTTP/1.1", "http://localhost/*"],
    ])("%s (dots inside a segment or in the query) is accepted", async (requestLine, href) => {
      await withServer(async (port) => {
        const result = await sendRaw(port, requestLine);
        expect(result.statusLine).toMatch(/^HTTP\/1\.1 200 /);
        expect(result.body).toContain(href);
      });
    });
  });

  describe("fragment (#) in request target", () => {
    // RFC 9112 origin-form request-targets have no fragment, but a malicious
    // client can send a raw `#` and Node passes it through verbatim. The fast
    // path must not fold the fragment into pathname/search/searchParams; it
    // should match the spec-correct native URL parse instead (CWE-436).
    const cases = [
      // [input, pathname, search, id searchParams]
      ["/admin/users#frag", "/admin/users", "", []],
      ["/admin#x", "/admin", "", []],
      ["/api/item?id=1#&id=2", "/api/item", "?id=1", ["1"]],
      ["/p#a?b=c", "/p", "", []],
      ["/p?q=1#frag", "/p", "?q=1", []],
      ["/items?id=1#x", "/items", "?id=1", ["1"]],
    ] as const;

    for (const [input, pathname, search, ids] of cases) {
      test(`FastURL "${input}" matches native URL`, () => {
        const std = new URL(`http://localhost${input}`);
        // sanity: our expectations track the spec parser
        expect(std.pathname).toBe(pathname);
        expect(std.search).toBe(search);
        expect(std.searchParams.getAll("id")).toEqual([...ids]);

        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.pathname, ".pathname").toBe(pathname);
        expect(url.search, ".search").toBe(search);
        expect(url.searchParams.getAll("id"), ".searchParams id").toEqual([...ids]);
        expect(url.hash, ".hash").toBe(std.hash);
      });

      test(`FastURL "${input}" stays consistent after deopt`, () => {
        const std = new URL(`http://localhost${input}`);
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        void url.hostname; // force deopt to native URL
        expect(url.pathname, ".pathname").toBe(pathname);
        expect(url.search, ".search").toBe(search);
        expect(url.hash, ".hash").toBe(std.hash);
      });
    }

    test(`bare FastURL("/p#frag") strips the fragment`, () => {
      const url = new FastURL("/p#frag");
      expect(url.pathname).toBe("/p");
      expect(url.search).toBe("");
    });
  });

  describe(".hash", () => {
    test("is empty without a full parse for object-form input", () => {
      const url = new NodeRequestURL({
        req: { url: "/p?a=1", headers: { host: "localhost" } } as any,
      });
      expect(url.hash).toBe("");
      expect(url.pathname).toBe("/p"); // still on the fast path
      expect(url.search).toBe("?a=1");
    });

    test("is empty without a full parse for origin-form string input", () => {
      const url = new FastURL("/p?a=1");
      expect(url.hash).toBe("");
      expect(url.pathname).toBe("/p");
      expect(url.search).toBe("?a=1");
    });

    test("is preserved for absolute-form string input", () => {
      expect(new FastURL("https://example.com/a#b").hash).toBe("#b");
      expect(new FastURL("https://example.com/a?q=1#b=c").hash).toBe("#b=c");
      expect(new FastURL("https://example.com/a").hash).toBe("");
    });

    test("setter is reflected in .hash and .href", () => {
      const url = new FastURL("/p?a=1");
      url.hash = "#frag";
      expect(url.hash).toBe("#frag");
      expect(url.href).toBe("http://localhost/p?a=1#frag");
      expect(url.pathname).toBe("/p");
    });
  });

  describe("path percent-encode set in request target", () => {
    // Characters Node's HTTP parser delivers verbatim but the WHATWG URL
    // parser percent-encodes in the path (" < > ` { }). The fast path must
    // match native so `url.pathname` stays consistent with
    // `new URL(url.href).pathname` (what `new Request(req)` / patchGlobalRequest
    // compute). Same interpretation-conflict class as the fragment case
    // (CWE-436) but encoding-only — no truncation, and searchParams is
    // unaffected — so this is consistency hardening, not a demonstrated bypass.
    // (Control chars and space are rejected by Node with 400, so excluded.)
    const chars = ['"', "<", ">", "`", "{", "}"];

    for (const ch of chars) {
      const input = `/a${ch}b`;
      test(`FastURL "${input}" matches native pathname`, () => {
        const expected = new URL(`http://localhost${input}`).pathname;
        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.pathname).toBe(expected);
        expect(url.pathname).not.toBe(input); // sanity: native did encode it
      });
    }
  });

  describe("query percent-encode set in request target", () => {
    // Characters Node's HTTP parser delivers verbatim but the WHATWG URL parser
    // percent-encodes in the query (" ' < >). This set is narrower than the path
    // set (` { } are NOT encoded in the query). The fast path must match native so
    // `url.search` / `url.href` stay consistent with `new URL(url.href)` — apps that
    // reflect the raw query into HTML are XSS-safe on Deno/Bun/CF but would leak raw
    // `< > " '` under Node's fast path otherwise. Same interpretation-conflict class
    // (CWE-436) as the path/fragment cases; `searchParams` decodes identically.
    // (Control chars and space are rejected by Node with 400, so excluded.)
    const chars = ['"', "'", "<", ">"];

    for (const ch of chars) {
      const input = `/p?x=${ch}a${ch}`;
      test(`FastURL "${input}" matches native search & href`, () => {
        const std = new URL(`http://localhost${input}`);
        expect(std.search).not.toBe(`?x=${ch}a${ch}`); // sanity: native encoded it

        const url = new NodeRequestURL({
          req: { url: input, headers: { host: "localhost" } } as any,
        });
        expect(url.search, ".search").toBe(std.search);
        expect(url.href, ".href").toBe(std.href);
        // searchParams still decodes to the raw value
        expect(url.searchParams.get("x"), ".searchParams x").toBe(`${ch}a${ch}`);
        expect(url.searchParams.get("x")).toBe(std.searchParams.get("x"));
      });
    }

    test("path + query combined matches native", () => {
      const input = `/a<b?y=>c&z="d'`;
      const std = new URL(`http://localhost${input}`);
      const url = new NodeRequestURL({
        req: { url: input, headers: { host: "localhost" } } as any,
      });
      expect(url.pathname, ".pathname").toBe(std.pathname);
      expect(url.search, ".search").toBe(std.search);
      expect(url.href, ".href").toBe(std.href);
      expect(url.searchParams.get("y"), ".searchParams y").toBe(">c");
      expect(url.searchParams.get("z"), ".searchParams z").toBe("\"d'");
    });
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

  describe("pathname setter", () => {
    // Setting `pathname` updates the (web) URL view but must NOT mutate the
    // raw Node `req.url`, so the original wire-encoded target stays available.
    // See h3js/h3#1432.
    test("does not mutate raw req.url", () => {
      const req = { url: "/h%65llo?q=%41", headers: { host: "localhost" } } as any;
      const url = new NodeRequestURL({ req });
      url.pathname = "/decoded";
      expect(url.pathname).toBe("/decoded");
      expect(url.href).toBe("http://localhost/decoded?q=%41");
      // raw node request target preserved
      expect(req.url).toBe("/h%65llo?q=%41");
    });

    test("does not mutate raw req.url after deopt", () => {
      const req = { url: "/foo?q=1", headers: { host: "localhost" } } as any;
      const url = new NodeRequestURL({ req });
      void url.hostname; // force deopt to native URL
      url.pathname = "/base/foo";
      expect(url.pathname).toBe("/base/foo");
      expect(req.url).toBe("/foo?q=1");
    });
  });
});

// The Node adapter's request-target gate (`serve()`, `toNodeHandler()`) and
// `FastURL`'s origin-form normalization (#359) must agree on what a dot segment
// is: a target passes the gate exactly when `FastURL` keeps its path verbatim.
describe("hasAmbiguousPath", () => {
  const rejected = [
    "/a/../b",
    "/a/./b",
    "/a/%2e%2e/b",
    "/a/%2E%2E/b",
    "/a/.%2e/b",
    "/a/.%2E/b",
    "/a/%2e./b",
    "/a/%2E./b",
    "/a/%2e/b",
    "/a/%2E/b",
    "/a/..",
    "/a/.",
    "/a/%2e",
    "/a/%2e%2e",
    "/..",
    "/.",
    "/../a",
    "/./a",
    "//..",
    "/a//./b",
    "/a/..?q=1",
    "/a/.?q=1",
    "/a/..#x",
    "/a/..?q=/ok",
    "/a.b/../c",
    "/a.b/c.d/./e",
    "/x.y/%2e%2e/z",
    "/a%20b/%2e/c",
    "/a%20b/x.y/.%2e",
    String.raw`/a\b`,
    String.raw`/a\b?q=1`,
  ];
  const accepted = [
    "/",
    "/api/users/123",
    "/assets/app.3f9a.js",
    "/.well-known/x",
    "/a/.hidden",
    "/.hidden",
    "/a/...",
    "/a/.../b",
    "/a/..b",
    "/a/.b.",
    "/a/b..",
    "/a/b.",
    "/a.b/c",
    "/a/%2e%2e%2e",
    "/a/.%2e.",
    "/a/%2ex",
    "/a/x%2e",
    "/a/%2",
    "/a/.%2",
    "/a/%",
    "/a/%2f..",
    "/a/%20",
    "/a%5Cb",
    "/a.b/c.d/e.f",
    "/caf%C3%A9/na%C3%AFve/x%20y",
    "/x?p=/../a",
    "/x?/./a",
    "/x?p=%2e%2e",
    String.raw`/x?q=\a`,
    "/x?q=/a/../b&r=.",
  ];

  test.each(rejected)("%s is rejected", (target) => {
    expect(hasAmbiguousPath(target)).toBe(true);
    // The fetch-side view would rewrite this path.
    const path = target.split("?")[0]!.split("#")[0]!;
    expect(new FastURL(target).pathname).not.toBe(path);
  });

  test.each(accepted)("%s is accepted", (target) => {
    expect(hasAmbiguousPath(target)).toBe(false);
    // Passing the gate, the path reaches the fetch handler verbatim.
    expect(new FastURL(target).pathname).toBe(target.split("?")[0]);
  });

  test.each([
    ["http://localhost/a/../b", true],
    ["http://localhost/a/%2e%2e/b", true],
    ["http://localhost/a/.", true],
    ["http://u@h:8080/a/../b", true],
    ["/a/%2E%2e", true],
    ["http://localhost/a.b/c?p=/../a", false],
    ["http://localhost:8080/api/users/123?x=1", false],
    ["http://localhost", false],
    ["*", false],
  ] as const)("absolute-form, asterisk-form and mixed case: %s => %s", (target, expected) => {
    expect(hasAmbiguousPath(target)).toBe(expected);
  });
});
