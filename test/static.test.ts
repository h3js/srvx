import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic, type ServeStaticOptions } from "../src/static.ts";
import type { ServerRequest } from "../src/types.ts";

let tmp: string;
let dir: string;
let linkedDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "srvx-static-"));

  // <tmp>/outside/secret.txt is never inside the served root.
  await mkdir(join(tmp, "outside"), { recursive: true });
  await writeFile(join(tmp, "outside", "secret.txt"), "TOPSECRET");

  // <tmp>/public is the served root.
  dir = join(tmp, "public");
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<h1>index</h1>");
  await writeFile(join(dir, "sub", "inside.txt"), "INSIDE");

  // Dotfiles: bare, with an extension, nested, and inside a dot directory.
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".env"), "DOTENV");
  await writeFile(join(dir, ".env.production"), "PROD_SECRET");
  await writeFile(join(dir, "sub", ".env.local"), "LOCAL_SECRET");
  await writeFile(join(dir, ".git", "config.txt"), "GIT_CONFIG");

  // `.well-known` (RFC 8615) is a dot directory and gets no exemption.
  await mkdir(join(dir, ".well-known"), { recursive: true });
  await writeFile(join(dir, ".well-known", "security.txt"), "SECURITY_TXT");

  // Precompressed variants. Contents are markers, not real brotli/gzip: the
  // middleware serves the bytes as-is and never decompresses them.
  await writeFile(join(dir, "app.js"), "PLAIN_JS");
  await writeFile(join(dir, "app.js.br"), "BROTLI_JS");
  await writeFile(join(dir, "app.js.gz"), "GZIP_JS");
  await writeFile(join(dir, "only-gz.js"), "PLAIN_ONLY_GZ");
  await writeFile(join(dir, "only-gz.js.gz"), "GZIP_ONLY_GZ");

  // Extension-less files, reachable at their exact name.
  await writeFile(join(dir, "LICENSE"), "LICENSE_BODY");
  await writeFile(join(dir, "apple-app-site-association"), "AASA_BODY");
  await mkdir(join(dir, ".well-known", "acme-challenge"), { recursive: true });
  await writeFile(join(dir, ".well-known", "acme-challenge", "tok3n"), "ACME_KEY_AUTH");

  // An extension-less route that must still resolve to its `.html` file.
  await writeFile(join(dir, "about.html"), "<h1>about</h1>");

  // Names that only appear percent-encoded on the wire.
  await writeFile(join(dir, "hello world.txt"), "SPACE_NAME");
  await writeFile(join(dir, "café.txt"), "UNICODE_NAME");
  await writeFile(join(dir, "50%.txt"), "PERCENT_NAME");

  // Already-compressed type: a `.br` next to it must never be looked up.
  await writeFile(join(dir, "logo.png"), "PNG_BYTES");
  await writeFile(join(dir, "logo.png.br"), "PNG_BR_SHOULD_BE_IGNORED");

  // Escaping links: one to a file, one to a directory.
  await symlink(join(tmp, "outside", "secret.txt"), join(dir, "escape.txt"));
  await symlink(join(tmp, "outside"), join(dir, "escape-dir"));

  // An escaping link reached via the precompressed-variant lookup: the plain
  // file is contained, but `.br` points outside the root.
  await writeFile(join(dir, "escape-variant.js"), "PLAIN_VARIANT");
  await symlink(join(tmp, "outside", "secret.txt"), join(dir, "escape-variant.js.br"));

  // A link that stays within the root must keep working.
  await symlink(join(dir, "sub", "inside.txt"), join(dir, "contained.txt"));

  // A root that is itself a symlink must keep working.
  linkedDir = join(tmp, "public-link");
  await symlink(dir, linkedDir);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const req = (path: string) => new Request(`http://localhost${path}`) as unknown as ServerRequest;
const notFound = () => new Response("next()", { status: 404 });

const fetchStatic = (path: string, root = dir) =>
  serveStatic({ dir: root })(req(path), notFound) as Promise<Response>;

const fetchWithDotfiles = (path: string) =>
  serveStatic({ dir, dotfiles: true })(req(path), notFound) as Promise<Response>;

const fetchWith = (path: string, init: RequestInit, opts: Partial<ServeStaticOptions> = {}) =>
  serveStatic({ dir, ...opts })(
    new Request(`http://localhost${path}`, init) as unknown as ServerRequest,
    notFound,
  ) as Promise<Response>;

const fetchEncoded = (path: string, acceptEncoding: string) =>
  fetchWith(path, { headers: { "accept-encoding": acceptEncoding } });

describe("serveStatic", () => {
  test("serves a file", async () => {
    const res = await fetchStatic("/sub/inside.txt");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("INSIDE");
  });

  test("serves index.html for /", async () => {
    const res = await fetchStatic("/");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("index");
  });

  describe("symlinks", () => {
    test("does not serve a symlink escaping the root", async () => {
      const res = await fetchStatic("/escape.txt");
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.not.toContain("TOPSECRET");
    });

    test("does not serve through a symlinked directory escaping the root", async () => {
      const res = await fetchStatic("/escape-dir/secret.txt");
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.not.toContain("TOPSECRET");
    });

    test("serves a symlink contained within the root", async () => {
      const res = await fetchStatic("/contained.txt");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("INSIDE");
    });

    test("serves files when dir is itself a symlink", async () => {
      const res = await fetchStatic("/sub/inside.txt", linkedDir);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("INSIDE");
    });

    test("still rejects an escaping symlink when dir is itself a symlink", async () => {
      const res = await fetchStatic("/escape.txt", linkedDir);
      expect(res.status).toBe(404);
    });
  });

  describe("dotfiles", () => {
    test.each([
      ["/.env", "DOTENV"],
      ["/.env.production", "PROD_SECRET"],
      ["/sub/.env.local", "LOCAL_SECRET"],
      ["/.git/config.txt", "GIT_CONFIG"],
    ])("does not serve %s by default", async (path, secret) => {
      const res = await fetchStatic(path);
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.not.toContain(secret);
    });

    test.each([
      ["/.env", "DOTENV"],
      ["/.env.production", "PROD_SECRET"],
      ["/sub/.env.local", "LOCAL_SECRET"],
      ["/.git/config.txt", "GIT_CONFIG"],
    ])("serves %s with dotfiles: true", async (path, contents) => {
      const res = await fetchWithDotfiles(path);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(contents);
    });

    test("gives .well-known no exemption, serving it only with dotfiles: true", async () => {
      // `.well-known` (RFC 8615) is a dot directory like any other, so serving
      // well-known URIs from `dir` requires opting in.
      expect((await fetchStatic("/.well-known/security.txt")).status).toBe(404);

      const res = await fetchWithDotfiles("/.well-known/security.txt");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("SECURITY_TXT");
    });

    test("does not mistake resolved `..` segments for dotfiles", async () => {
      // `join()` resolves these to `/index.html` before the dotfile check.
      for (const path of ["/sub/../index.html", "/./index.html"]) {
        const res = await fetchStatic(path);
        expect(res.status, path).toBe(200);
        await expect(res.text()).resolves.toContain("index");
      }
    });
  });

  describe("precompressed lookup", () => {
    test("prefers brotli when both variants exist", async () => {
      const res = await fetchEncoded("/app.js", "gzip, br");
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-type")).toBe("text/javascript");
      await expect(res.text()).resolves.toBe("BROTLI_JS");
    });

    test("falls back to gzip when brotli is not accepted", async () => {
      const res = await fetchEncoded("/app.js", "gzip");
      expect(res.headers.get("content-encoding")).toBe("gzip");
      await expect(res.text()).resolves.toBe("GZIP_JS");
    });

    test("falls back to the plain file when no variant is accepted", async () => {
      const res = await fetchEncoded("/app.js", "");
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("falls back to the plain file when no variant exists on disk", async () => {
      const res = await fetchEncoded("/index.html", "br");
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toContain("index");
    });

    test("skips a missing variant and uses the next accepted one", async () => {
      const res = await fetchEncoded("/only-gz.js", "br, gzip");
      expect(res.headers.get("content-encoding")).toBe("gzip");
      await expect(res.text()).resolves.toBe("GZIP_ONLY_GZ");
    });

    test("honors q=0 as a refusal", async () => {
      const res = await fetchEncoded("/app.js", "br;q=0, gzip");
      expect(res.headers.get("content-encoding")).toBe("gzip");
      await expect(res.text()).resolves.toBe("GZIP_JS");
    });

    test("honors an explicit q ranking", async () => {
      const res = await fetchEncoded("/app.js", "br;q=1.0");
      expect(res.headers.get("content-encoding")).toBe("br");
      await expect(res.text()).resolves.toBe("BROTLI_JS");
    });

    test("supports the * wildcard", async () => {
      const res = await fetchEncoded("/app.js", "*");
      expect(res.headers.get("content-encoding")).toBe("br");
    });

    test("does not match an encoding as a substring", async () => {
      // "x-gzip" must not satisfy "gzip", nor "brotli" satisfy "br".
      const res = await fetchEncoded("/app.js", "x-gzip, brotli");
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("sets Vary: Accept-Encoding whenever variants are configured", async () => {
      expect((await fetchEncoded("/app.js", "br")).headers.get("vary")).toBe("Accept-Encoding");
      // Also on the uncompressed response: caches must key on the header.
      expect((await fetchEncoded("/index.html", "")).headers.get("vary")).toBe("Accept-Encoding");
    });

    test("sets Content-Length to the served variant's size", async () => {
      const res = await fetchEncoded("/app.js", "br");
      expect(res.headers.get("content-length")).toBe(String("BROTLI_JS".length));
    });

    test("serves the plain file with encodings: {}", async () => {
      const res = await fetchWith(
        "/app.js",
        { headers: { "accept-encoding": "br" } },
        {
          encodings: {},
        },
      );
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(res.headers.get("vary")).toBe(null);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("rejects a variant escaping the root and falls back to the plain file", async () => {
      // `escape-variant.js.br` symlinks outside the root; the plain file does not.
      const res = await fetchEncoded("/escape-variant.js", "br");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe(null);
      const body = await res.text();
      expect(body).toBe("PLAIN_VARIANT");
      expect(body).not.toContain("TOPSECRET");
    });
  });

  describe("extension-less paths", () => {
    test.each([
      ["/LICENSE", "LICENSE_BODY"],
      ["/apple-app-site-association", "AASA_BODY"],
    ])("serves %s at its exact name", async (path, contents) => {
      const res = await fetchStatic(path);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(contents);
    });

    test("still resolves an extension-less route to its .html file", async () => {
      const res = await fetchStatic("/about");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("about");
    });

    test("serves an ACME challenge token with dotfiles: true", async () => {
      // Extension-less and under a dot directory: needs both the literal probe
      // and the dotfiles opt-in.
      expect((await fetchStatic("/.well-known/acme-challenge/tok3n")).status).toBe(404);

      const res = await fetchWithDotfiles("/.well-known/acme-challenge/tok3n");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("ACME_KEY_AUTH");
    });
  });

  describe("incompressible types", () => {
    test("never serves a variant for an already-compressed type", async () => {
      const res = await fetchEncoded("/logo.png", "br");
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe("PNG_BYTES");
    });

    test("omits Vary for an already-compressed type", async () => {
      expect((await fetchEncoded("/logo.png", "br")).headers.get("vary")).toBe(null);
      // ...but still sets it for compressible types.
      expect((await fetchEncoded("/index.html", "br")).headers.get("vary")).toBe("Accept-Encoding");
    });

    test.each([
      ["/mod.wasm", "application/wasm"],
      ["/pic.avif", "image/avif"],
      ["/song.mp3", "audio/mpeg"],
      ["/bundle.gz", "application/gzip"],
    ])("maps %s to %s", async (path, type) => {
      await writeFile(join(dir, path.slice(1)), "X");
      const res = await fetchStatic(path);
      expect(res.headers.get("content-type")).toBe(type);
    });
  });

  describe("HEAD", () => {
    test("returns headers with no body", async () => {
      const res = await fetchWith("/app.js", { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String("PLAIN_JS".length));
      expect(res.headers.get("content-type")).toBe("text/javascript");
      await expect(res.text()).resolves.toBe("");
    });

    test("reports the variant's headers without a body", async () => {
      const res = await fetchWith("/app.js", {
        method: "HEAD",
        headers: { "accept-encoding": "br" },
      });
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-length")).toBe(String("BROTLI_JS".length));
      await expect(res.text()).resolves.toBe("");
    });

    test("returns no body for a renderHTML route", async () => {
      const opts = {
        renderHTML: ({ html }: { html: string }) =>
          new Response(`${html}<!--rendered-->`, { headers: { "x-rendered": "1" } }),
      };
      const get = await fetchWith("/index.html", {}, opts);
      await expect(get.text()).resolves.toContain("<!--rendered-->");

      const head = await fetchWith("/index.html", { method: "HEAD" }, opts);
      expect(head.status).toBe(200);
      expect(head.headers.get("x-rendered")).toBe("1");
      await expect(head.text()).resolves.toBe("");
    });

    test("cancels the unused rendered body", async () => {
      let cancelled = false;
      const opts = {
        renderHTML: () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      };
      const head = await fetchWith("/index.html", { method: "HEAD" }, opts);
      await expect(head.text()).resolves.toBe("");
      expect(cancelled).toBe(true);
    });
  });

  describe("percent-encoded paths", () => {
    test("decodes the pathname once for the lookup", async () => {
      const res = await fetchStatic("/hello%20world.txt");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("SPACE_NAME");
    });

    test("decodes non-ASCII names", async () => {
      await expect(fetchStatic("/caf%C3%A9.txt").then((r) => r.text())).resolves.toBe(
        "UNICODE_NAME",
      );
    });

    test("decodes an encoded literal percent", async () => {
      await expect(fetchStatic("/50%25.txt").then((r) => r.text())).resolves.toBe("PERCENT_NAME");
    });

    test("keeps an encoded separator encoded", async () => {
      // `%2F` must not become a path separator: the decoded lookup is for a
      // file literally named `sub%2Finside.txt`, which does not exist.
      expect((await fetchStatic("/sub%2Finside.txt")).status).toBe(404);
    });

    test("applies the dotfile policy to the decoded name", async () => {
      expect((await fetchStatic("/%2Eenv")).status).toBe(404);
      await expect(fetchWithDotfiles("/%2Eenv").then((r) => r.text())).resolves.toBe("DOTENV");
    });

    test("does not decode twice", async () => {
      // `%252e%252e` decodes once to the harmless literal `%2e%2e`.
      const res = await fetchStatic("/%252e%252e/outside/secret.txt");
      expect(res.status).toBe(404);
    });

    test("rejects malformed encoding with 400", async () => {
      for (const path of ["/foo%", "/%ZZ"]) {
        expect((await fetchStatic(path)).status, path).toBe(400);
      }
    });
  });

  test("does not serve traversal outside the root", async () => {
    for (const path of ["/../outside/secret.txt", "/%2e%2e%2foutside%2fsecret.txt"]) {
      const res = await fetchStatic(path);
      expect(res.status, path).toBe(404);
    }
  });
});
