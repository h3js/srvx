import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { serveStatic } from "../src/static.ts";
import type { ServeStaticOptions } from "../src/static.ts";
import type { ServerRequest } from "../src/types.ts";

let root: string;
let dir: string;

// A large-enough, highly compressible text payload.
const TEXT_BODY = "hello compressible world\n".repeat(200);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "srvx-static-"));
  dir = join(root, "public");
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "index.html"), "<h1>home</h1>");
  writeFileSync(join(dir, "about.html"), "<h1>about</h1>");
  writeFileSync(join(dir, "hello world.txt"), "spaces");
  writeFileSync(join(dir, "café.txt"), "unicode");
  writeFileSync(join(dir, "data.json"), '{"a":1}');
  writeFileSync(join(dir, "page.txt"), TEXT_BODY);
  // A PNG-ish binary file (content irrelevant, extension drives MIME type).
  writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(dir, "icon.svg"), "<svg></svg>");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  // Dotfiles that carry an extension, so the extensionless `.html` fallback
  // cannot 404 them by accident. These fail if the dot denylist regresses.
  writeFileSync(join(dir, ".env.local"), "SECRET=2");
  writeFileSync(join(dir, ".npmrc.bak"), "//registry/:_authToken=tok");

  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "index.html"), "<h1>sub</h1>");

  mkdirSync(join(dir, ".secret"), { recursive: true });
  writeFileSync(join(dir, ".secret", "config"), "topsecret");

  // `/.well-known/` (RFC 8615) is exempt from the dot denylist.
  mkdirSync(join(dir, ".well-known", "acme-challenge"), { recursive: true });
  // ACME tokens are extensionless and must be served verbatim, not via `.html`.
  writeFileSync(join(dir, ".well-known", "acme-challenge", "token123"), "acme-proof");
  writeFileSync(join(dir, ".well-known", "security.txt"), "Contact: mailto:x@y.z");
  // A dotfile *below* `.well-known` stays denied.
  writeFileSync(join(dir, ".well-known", ".env"), "SECRET=3");
  // `.well-known` is only well-known at the root; nested it stays denied.
  mkdirSync(join(dir, "sub", ".well-known"), { recursive: true });
  writeFileSync(join(dir, "sub", ".well-known", "nope.txt"), "nested");

  // A file outside `dir` that a symlink inside `dir` points at.
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "escaped");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NEXT = "__NEXT__";

async function req(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
  options: Partial<ServeStaticOptions> = {},
): Promise<Response> {
  const mw = serveStatic({ dir, ...options });
  const request = new Request(`http://localhost${path}`, {
    method: init.method || "GET",
    headers: init.headers,
  }) as unknown as ServerRequest;
  return mw(request, () => new Response(NEXT, { status: 404 }));
}

/** Fully drain the body so no file stream is left dangling past cleanup. */
async function head(res: Response): Promise<Response> {
  await res.arrayBuffer().catch(() => {});
  return res;
}

describe("serveStatic: routing & resolution", () => {
  test("serves index.html at root", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  test("resolves extensionless path to .html", async () => {
    const res = await req("/about");
    expect(await res.text()).toBe("<h1>about</h1>");
  });

  test("resolves directory to index.html", async () => {
    const res = await req("/sub");
    expect(await res.text()).toBe("<h1>sub</h1>");
  });

  test("404 fallthrough for missing file", async () => {
    const res = await req("/missing.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("ignores non GET/HEAD methods", async () => {
    const res = await req("/", { method: "POST" });
    expect(await res.text()).toBe(NEXT);
  });
});

describe("serveStatic: percent-decoding", () => {
  test("serves a filename with a space", async () => {
    const res = await req("/hello%20world.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spaces");
  });

  test("serves a unicode filename", async () => {
    const res = await req("/caf%C3%A9.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unicode");
  });

  test("malformed percent-encoding falls through (no crash)", async () => {
    const res = await req("/%E0%A4%A.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });
});

describe("serveStatic: traversal & dotfiles", () => {
  test("raw ../ cannot escape dir", async () => {
    const res = await req("/../../outside/secret.txt");
    expect(await res.text()).toBe(NEXT);
  });

  test("encoded %2e%2e traversal is blocked", async () => {
    const res = await req("/%2e%2e%2foutside%2fsecret.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("encoded ..%2f traversal is blocked", async () => {
    const res = await req("/..%2f..%2foutside%2fsecret.txt");
    expect(await res.text()).toBe(NEXT);
  });

  test("dotfile is denied", async () => {
    const res = await req("/.env");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  // `/.env` alone would 404 even without the denylist, because `extname(".env")`
  // is "" and the fallback looks for `.env.html`. These carry an extension, so
  // they resolve to a real file and only the denylist can stop them.
  test.each(["/.env.local", "/.npmrc.bak"])("dotfile %s is denied", async (path) => {
    const res = await req(path);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("file inside a dot directory is denied", async () => {
    const res = await req("/.secret/config");
    expect(await res.text()).toBe(NEXT);
  });

  test("symlink escaping dir is denied", async () => {
    const res = await req("/link.txt");
    expect(await res.text()).toBe(NEXT);
  });
});

describe("serveStatic: .well-known (RFC 8615)", () => {
  test("serves an extensionless ACME challenge token verbatim", async () => {
    const res = await req("/.well-known/acme-challenge/token123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("acme-proof");
  });

  test("serves security.txt", async () => {
    const res = await req("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Contact: mailto:x@y.z");
  });

  test("does not apply the .html fallback under .well-known", async () => {
    const res = await req("/.well-known/acme-challenge/missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("a dotfile below .well-known is still denied", async () => {
    const res = await req("/.well-known/.env");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("traversal out of .well-known is still denied", async () => {
    const res = await req("/.well-known/..%2f.env.local");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });

  test("nested .well-known is not exempt", async () => {
    const res = await req("/sub/.well-known/nope.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEXT);
  });
});

describe("serveStatic: MIME types", () => {
  test.each([
    ["/data.json", "application/json"],
    ["/pic.png", "image/png"],
    ["/icon.svg", "image/svg+xml"],
    ["/page.txt", "text/plain"],
    ["/about", "text/html"],
  ])("%s -> %s", async (path, type) => {
    const res = await head(await req(path));
    expect(res.headers.get("content-type")).toBe(type);
  });
});

describe("serveStatic: encoding negotiation", () => {
  test("gzip", async () => {
    const res = await req("/page.txt", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBeNull();
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(body).toBe(TEXT_BODY);
  });

  test("brotli", async () => {
    const res = await req("/page.txt", { headers: { "accept-encoding": "br" } });
    expect(res.headers.get("content-encoding")).toBe("br");
    const body = brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(body).toBe(TEXT_BODY);
  });

  test("prefers brotli when both are acceptable", async () => {
    const res = await head(await req("/page.txt", { headers: { "accept-encoding": "gzip, br" } }));
    expect(res.headers.get("content-encoding")).toBe("br");
  });

  test("br;q=0 disables brotli, falls back to gzip", async () => {
    const res = await head(
      await req("/page.txt", { headers: { "accept-encoding": "br;q=0, gzip" } }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("br;q=0 alone falls back to identity", async () => {
    const res = await req("/page.txt", { headers: { "accept-encoding": "br;q=0" } });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(TEXT_BODY);
  });

  test("'abbr' does not match 'br'", async () => {
    const res = await req("/page.txt", { headers: { "accept-encoding": "abbr" } });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(TEXT_BODY);
  });

  test("no accept-encoding -> identity", async () => {
    const res = await req("/page.txt");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(TEXT_BODY);
  });

  test("already-compressed types are not re-encoded", async () => {
    const res = await head(await req("/pic.png", { headers: { "accept-encoding": "gzip, br" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBeNull();
  });
});

describe("serveStatic: Vary", () => {
  test("Vary on the compressed variant", async () => {
    const res = await head(await req("/page.txt", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("Vary on the identity variant of a compressible type", async () => {
    const res = await head(await req("/page.txt"));
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("no Vary on already-compressed types", async () => {
    const res = await head(await req("/pic.png"));
    expect(res.headers.get("vary")).toBeNull();
  });
});

describe("serveStatic: HEAD", () => {
  test("HEAD sends headers but no body", async () => {
    const res = await req("/page.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(TEXT_BODY)));
    expect(res.headers.get("etag")).toBeTruthy();
    expect(await res.text()).toBe("");
  });

  test("HEAD with accept-encoding negotiates without a body", async () => {
    const res = await req("/page.txt", {
      method: "HEAD",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("");
  });
});

describe("serveStatic: caching & conditional requests", () => {
  test("sets ETag, Last-Modified and Cache-Control", async () => {
    const res = await head(await req("/page.txt"));
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  test("If-None-Match hit -> 304 with no body", async () => {
    const first = await head(await req("/page.txt"));
    const etag = first.headers.get("etag")!;
    const res = await req("/page.txt", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("If-None-Match miss -> 200", async () => {
    const res = await head(
      await req("/page.txt", { headers: { "if-none-match": 'W/"deadbeef-1"' } }),
    );
    expect(res.status).toBe(200);
  });

  test("If-Modified-Since not modified -> 304", async () => {
    const first = await head(await req("/page.txt"));
    const lastModified = first.headers.get("last-modified")!;
    const res = await req("/page.txt", {
      headers: { "if-modified-since": lastModified },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("If-Modified-Since in the past -> 200", async () => {
    const res = await head(
      await req("/page.txt", { headers: { "if-modified-since": new Date(0).toUTCString() } }),
    );
    expect(res.status).toBe(200);
  });

  test("cacheControl option can be disabled", async () => {
    const res = await head(await req("/page.txt", {}, { cacheControl: false }));
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
