/**
 * Tests for NodeRequestHeaders duplicate header handling.
 *
 * In HTTP/2, cookies arrive as separate rawHeaders entries.
 * The headers iterator must combine them (via append) so that
 * Object.fromEntries(headers.entries()) doesn't lose values.
 *
 * Ref: https://github.com/h3js/srvx/issues/188
 */
import http from "node:http";
import { connect as tlsConnect } from "node:tls";
import { describe, expect, test } from "vitest";
import { NodeRequestHeaders } from "../src/adapters/_node/headers.ts";
import { serve } from "../src/adapters/node.ts";
import { getTLSCert } from "./_utils.ts";

function mockReq(rawHeaders: string[], headers: Record<string, string | string[]>) {
  return { rawHeaders, headers } as any;
}

describe("NodeRequestHeaders", () => {
  test("entries() combines duplicate headers (#188)", () => {
    // Simulate HTTP/2 splitting cookies into separate rawHeaders entries
    const req = mockReq(["cookie", "a=1", "cookie", "b=2", "host", "localhost"], {
      cookie: ["a=1", "b=2"],
      host: "localhost",
    });
    const headers = new NodeRequestHeaders(req);

    const entries = Object.fromEntries(headers.entries());
    // Should contain both cookies combined, not just the last one
    expect(entries.cookie).toContain("a=1");
    expect(entries.cookie).toContain("b=2");
    expect(entries.host).toBe("localhost");
  });

  test("[Symbol.iterator] combines duplicate headers (#188)", () => {
    const req = mockReq(["cookie", "first=1", "cookie", "second=2"], {
      cookie: ["first=1", "second=2"],
    });
    const headers = new NodeRequestHeaders(req);

    const entries = Object.fromEntries(headers);
    expect(entries.cookie).toContain("first=1");
    expect(entries.cookie).toContain("second=2");
  });

  test("get() combines duplicate headers", () => {
    const req = mockReq(["cookie", "a=1", "cookie", "b=2"], { cookie: ["a=1", "b=2"] });
    const headers = new NodeRequestHeaders(req);

    const cookie = headers.get("cookie");
    expect(cookie).toContain("a=1");
    expect(cookie).toContain("b=2");
  });

  test("get()/has() combine duplicate single-value headers regardless of iteration order", () => {
    // Node collapses headers it treats as single-value (authorization,
    // content-type, …) to the FIRST occurrence in `req.headers`, while
    // `rawHeaders` keeps every occurrence. The result must not depend on
    // whether the Headers object was iterated first.
    const rawHeaders = [
      "authorization",
      "Bearer AAA",
      "authorization",
      "Bearer BBB",
      "content-type",
      "text/plain",
      "content-type",
      "application/json",
    ];
    const collapsed = { authorization: "Bearer AAA", "content-type": "text/plain" };

    // Fresh instance: get() before any iteration.
    const before = new NodeRequestHeaders(mockReq(rawHeaders, collapsed));
    expect(before.get("authorization")).toBe("Bearer AAA, Bearer BBB");
    expect(before.get("content-type")).toBe("text/plain, application/json");
    expect(before.has("authorization")).toBe(true);

    // Separate instance, iterated first, then get(): must match.
    const after = new NodeRequestHeaders(mockReq(rawHeaders, collapsed));
    void [...after.entries()];
    expect(after.get("authorization")).toBe("Bearer AAA, Bearer BBB");
    expect(after.get("content-type")).toBe("text/plain, application/json");
  });

  test("get()/has() see a literal `__proto__` header", () => {
    // Node's `req.headers` can never carry an own `__proto__` key (the
    // prototype accessor swallows the assignment), so the fast path must
    // fall back to rawHeaders for this name.
    const withProto = new NodeRequestHeaders(
      mockReq(["__proto__", "evil", "x-a", "1"], { "x-a": "1" }),
    );
    expect(withProto.get("__proto__")).toBe("evil");
    expect(withProto.has("__proto__")).toBe(true);

    const withoutProto = new NodeRequestHeaders(mockReq(["x-a", "1"], { "x-a": "1" }));
    expect(withoutProto.get("__proto__")).toBe(null);
    expect(withoutProto.has("__proto__")).toBe(false);
  });

  test("get()/has() ignore `req.headers` prototype artifacts and reject invalid names", () => {
    const headers = new NodeRequestHeaders(mockReq(["x-a", "1"], { "x-a": "1" }));
    // Plain (non null-prototype) `req.headers` exposes Object.prototype members
    expect(headers.get("toString")).toBe(null);
    expect(headers.has("toString")).toBe(false);
    // Invalid names throw like native Headers
    expect(() => headers.get("foo bar")).toThrow(TypeError);
    expect(() => headers.has("foo bar")).toThrow(TypeError);
    expect(() => headers.get(":path")).toThrow(TypeError);
  });

  test("repeated cookie joins with '; ' on every path", () => {
    // Node joins repeated cookie headers with "; " in `req.headers` (as do
    // undici's and Bun's Headers) — the fast path returns it as-is.
    const req = mockReq(["cookie", "a=1", "cookie", "b=2"], { cookie: "a=1; b=2" });
    expect(new NodeRequestHeaders(req).get("cookie")).toBe("a=1; b=2");
    // Materialization joins cookie itself, as not every runtime's native
    // Headers does (Deno joins with ", ").
    const iterated = new NodeRequestHeaders(req);
    expect([...iterated]).toEqual([["cookie", "a=1; b=2"]]);
    expect(iterated.get("cookie")).toBe("a=1; b=2");
  });

  test("HTTP/2-only single-value headers: rawHeaders fallback only on HTTP/2", () => {
    // Shaped like `Http2ServerRequest`: pseudo-headers first in rawHeaders,
    // null-prototype `headers` keeping only the first `if-none-match`, cookie
    // crumbs joined with "; ".
    const h2 = new NodeRequestHeaders({
      httpVersionMajor: 2,
      rawHeaders: [
        ":method",
        "GET",
        ":path",
        "/",
        "if-none-match",
        '"a"',
        "cookie",
        "a=1",
        "if-none-match",
        '"b"',
        "cookie",
        "b=2",
      ],
      headers: {
        __proto__: null,
        ":method": "GET",
        ":path": "/",
        "if-none-match": '"a"',
        cookie: "a=1; b=2",
      },
    } as any);
    expect(h2.get("if-none-match")).toBe('"a", "b"');
    expect(h2.get("cookie")).toBe("a=1; b=2");
    expect([...h2]).toEqual([
      ["cookie", "a=1; b=2"],
      ["if-none-match", '"a", "b"'],
    ]);

    // HTTP/1 already joins `if-none-match` in `req.headers`: the fast path
    // must not scan rawHeaders for it.
    const h1 = new NodeRequestHeaders({
      httpVersionMajor: 1,
      get rawHeaders(): string[] {
        throw new Error("rawHeaders scanned");
      },
      headers: { "if-none-match": '"a", "b"' },
    } as any);
    expect(h1.get("if-none-match")).toBe('"a", "b"');
  });
});

// Real-socket coverage: Node's `req.headers` collapses a different set of
// repeated headers per protocol (HTTP/2 also keeps only the first
// `if-none-match`, `range`, `date`, …), so every read path must agree with
// native Headers built from the same fields.
describe("NodeRequestHeaders over real sockets (repeated fields)", () => {
  // Every pair is sent as its own header field, in order.
  const fields: [string, string][] = [
    ["if-none-match", '"a"'],
    ["if-none-match", '"b"'],
    ["if-match", '"c"'],
    ["if-match", '"d"'],
    ["if-range", '"e"'],
    ["if-range", '"f"'],
    ["range", "bytes=0-1"],
    ["range", "bytes=4-5"],
    ["date", "Tue, 01 Jan 2030 00:00:00 GMT"],
    ["date", "Wed, 02 Jan 2030 00:00:00 GMT"],
    ["content-encoding", "gzip"],
    ["content-encoding", "br"],
    ["content-language", "en"],
    ["content-language", "fr"],
    ["content-location", "/a"],
    ["content-location", "/b"],
    ["content-md5", "x"],
    ["content-md5", "y"],
    ["content-range", "bytes 0-1/10"],
    ["content-range", "bytes 4-5/10"],
    ["access-control-request-method", "GET"],
    ["access-control-request-method", "PUT"],
    ["access-control-max-age", "1"],
    ["access-control-max-age", "2"],
    ["access-control-allow-credentials", "true"],
    ["access-control-allow-credentials", "false"],
    ["dnt", "0"],
    ["dnt", "1"],
    ["tk", "N"],
    ["tk", "T"],
    ["upgrade-insecure-requests", "0"],
    ["upgrade-insecure-requests", "1"],
    ["x-content-type-options", "nosniff"],
    ["x-content-type-options", "other"],
    // Single-value on both protocols
    ["authorization", "Bearer AAA"],
    ["authorization", "Bearer BBB"],
    ["content-type", "text/plain"],
    ["content-type", "application/json"],
    ["user-agent", "ua-1"],
    ["user-agent", "ua-2"],
    // Joined by Node already
    ["x-custom", "1"],
    ["x-custom", "2"],
    ["accept", "text/html"],
    // HTTP/2 may split `cookie` into crumbs; they rejoin with "; "
    ["cookie", "a=1"],
    ["cookie", "b=2"],
    ["set-cookie", "s=1"],
    ["set-cookie", "t=2"],
  ];
  const names = [...new Set(fields.map(([name]) => name))];

  // Cookie fields rejoin with "; " (RFC 9113 §8.2.3). Appended pre-joined
  // as Deno's native Headers would join them with ", ".
  const ref = new Headers();
  for (const [name, value] of fields) {
    if (name !== "cookie") {
      ref.append(name, value);
    }
  }
  ref.append("cookie", "a=1; b=2");
  const expected = {
    get: Object.fromEntries(names.map((n) => [n, ref.get(n)])),
    has: Object.fromEntries(names.map((n) => [n, true])),
    getSetCookie: ref.getSetCookie(),
    entries: Object.fromEntries(ref),
  };

  // Sanity: the reference really is Fetch-joined (not Node-collapsed).
  test("reference values", () => {
    expect(expected.get["if-none-match"]).toBe('"a", "b"');
    expect(expected.get.range).toBe("bytes=0-1, bytes=4-5");
    expect(expected.get.cookie).toBe("a=1; b=2");
  });

  async function fetchHandler(request: any): Promise<Response> {
    const nodeReq = request.runtime.node.req;
    // A fresh wrapper per read keeps each get()/has() on the
    // un-materialized fast path.
    const fresh = () => new NodeRequestHeaders(nodeReq);
    const pick = (entries: Iterable<[string, string]>) =>
      Object.fromEntries([...entries].filter(([n]) => names.includes(n) || n.startsWith(":")));
    const forEach: [string, string][] = [];
    const iterated = new NodeRequestHeaders(nodeReq);
    iterated.forEach((value, name) => forEach.push([name, value]));
    const result = {
      get: Object.fromEntries(names.map((n) => [n, fresh().get(n)])),
      has: Object.fromEntries(names.map((n) => [n, fresh().has(n)])),
      getSetCookie: fresh().getSetCookie(),
      entries: pick(fresh().entries()),
      spread: pick([...fresh()]),
      forEach: pick(forEach),
      // After materialization, get() reads the native store
      getAfterIteration: Object.fromEntries(names.map((n) => [n, iterated.get(n)])),
      // `request.headers` + materialized native Request (`clone()`)
      requestHeaders: pick(request.headers),
      clonedHeaders: pick(request.clone().headers),
    };
    return Response.json(result);
  }

  function assertResult(result: any) {
    expect(result.get).toEqual(expected.get);
    expect(result.has).toEqual(expected.has);
    expect(result.getSetCookie).toEqual(expected.getSetCookie);
    // No pseudo-header leaks (`pick` keeps any `:`-prefixed name)
    expect(result.entries).toEqual(expected.entries);
    expect(result.spread).toEqual(expected.entries);
    expect(result.forEach).toEqual(expected.entries);
    expect(result.getAfterIteration).toEqual(expected.get);
    expect(result.requestHeaders).toEqual(expected.entries);
    expect(result.clonedHeaders).toEqual(expected.entries);
  }

  test("HTTP/1.1", async () => {
    const server = serve({ hostname: "127.0.0.1", port: 0, silent: true, fetch: fetchHandler });
    await server.ready();
    try {
      // A flat raw-headers array sends every field as-is, repeats included.
      const res = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = http.request(
          server.url!,
          { headers: ["host", "localhost", ...fields.flat()] },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
            );
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assertResult(parseResponse(res));
    } finally {
      await server.close(true);
    }
  });

  test("HTTP/2", async () => {
    const tls = await getTLSCert();
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
      tls,
      node: { http2: true, allowHTTP1: false } as any,
      fetch: fetchHandler,
    });
    await server.ready();
    try {
      const { port } = new URL(server.url!);
      const res = await rawHttp2Request(Number(port), tls.ca, [
        [":method", "GET"],
        [":scheme", "https"],
        [":authority", "localhost"],
        [":path", "/"],
        ...fields,
      ]);
      assertResult(parseResponse(res));
    } finally {
      await server.close(true);
    }
  });
});

function parseResponse(res: { status?: number; body: string }): unknown {
  if (res.status !== 200) {
    throw new Error(`Expected status 200, got ${res.status}: ${res.body}`);
  }
  return JSON.parse(res.body);
}

// HPACK static table indexes of `:status` values (RFC 7541 Appendix A)
const _hpackStatus: Record<number, number> = {
  8: 200,
  9: 204,
  10: 206,
  11: 304,
  12: 400,
  13: 404,
  14: 500,
};

/**
 * Minimal HTTP/2 client speaking raw frames. `node:http2`'s client refuses to
 * send a repeated single-value field (`ERR_HTTP2_HEADER_SINGLE_VALUE`), which
 * is exactly what these tests need. Headers go out as HPACK literals without
 * indexing (no Huffman); of the response only DATA and a `:status` sent as a
 * static-table index (how Node encodes the common codes) are read back.
 *
 * TODO: switch to `http2.connect(url, { strictSingleValueFields: false })` once
 * Node 22 support is dropped (the option needs Node >= 24.16 / 25.8).
 */
function rawHttp2Request(
  port: number,
  ca: string,
  fields: [string, string][],
): Promise<{ status?: number; body: string }> {
  const hpackInt = (value: number, prefixBits: number, flags: number) => {
    const max = (1 << prefixBits) - 1;
    if (value < max) {
      return [flags | value];
    }
    const out = [flags | max];
    value -= max;
    while (value >= 128) {
      out.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    out.push(value);
    return out;
  };
  const hpackString = (str: string) => {
    const bytes = Buffer.from(str, "latin1");
    return [...hpackInt(bytes.length, 7, 0), ...bytes];
  };
  const frame = (type: number, flags: number, streamId: number, payload: Buffer | number[]) => {
    const header = Buffer.alloc(9);
    header.writeUIntBE(payload.length, 0, 3);
    header[3] = type;
    header[4] = flags;
    header.writeUInt32BE(streamId, 5);
    return Buffer.concat([header, Buffer.from(payload)]);
  };
  const block = fields.flatMap(([name, value]) => [
    0x00,
    ...hpackString(name),
    ...hpackString(value),
  ]);

  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, ca, servername: "localhost", ALPNProtocols: ["h2"] },
      () => {
        socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        socket.write(frame(0x4 /* SETTINGS */, 0, 0, []));
        // END_STREAM | END_HEADERS
        socket.write(frame(0x1 /* HEADERS */, 0x1 | 0x4, 1, block));
      },
    );
    let buf = Buffer.alloc(0);
    const data: Buffer[] = [];
    let status: number | undefined;
    const done = (err?: Error) => {
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve({ status, body: Buffer.concat(data).toString("utf8") });
      }
    };
    socket.on("error", done);
    socket.on("close", () => done(new Error("connection closed before response end")));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 9) {
        const length = buf.readUIntBE(0, 3);
        if (buf.length < 9 + length) {
          break;
        }
        const [type, flags] = [buf[3], buf[4]];
        const streamId = buf.readUInt32BE(5) & 0x7f_ff_ff_ff;
        const payload = buf.subarray(9, 9 + length);
        buf = buf.subarray(9 + length);
        if (type === 0x4 /* SETTINGS */ && !(flags & 0x1)) {
          socket.write(frame(0x4, 0x1 /* ACK */, 0, []));
        } else if (type === 0x3 /* RST_STREAM */ || type === 0x7 /* GOAWAY */) {
          return done(new Error(`HTTP/2 ${type === 0x3 ? "RST_STREAM" : "GOAWAY"}`));
        } else if (streamId === 1 && (type === 0x0 /* DATA */ || type === 0x1) /* HEADERS */) {
          if (type === 0x0) {
            data.push(payload);
          } else if (status === undefined && payload[0] & 0x80) {
            // Indexed header field (no PADDED/PRIORITY flags from Node)
            status = _hpackStatus[payload[0] & 0x7f];
          }
          if (flags & 0x1 /* END_STREAM */) {
            return done();
          }
        }
      }
    });
  });
}
