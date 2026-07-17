import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, truncate, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { serveStatic, type ServeStaticOptions } from "../src/static.ts";
import { FastURL } from "../src/_url.ts";
import type { ServerRequest } from "../src/types.ts";

let tmp: string;
let dir: string;
let linkedDir: string;

// Over the 1 KiB floor under which nothing is compressed on the fly, and
// compressible enough that an encoded body is unmistakably smaller.
const BIG_JS = `/* ${"payload;".repeat(256)} */\n`;

// Stands in for a precompressed `.gz` on disk (never real gzip — the middleware
// serves those bytes as-is). Padded over the floor as well, so that a test
// reaching it is decided by variant-over-on-the-fly precedence and not by the
// size check quietly refusing to compress a short variant.
const BIG_GZ_MARKER = `GZIP_BIG_FROM_DISK ${"z".repeat(2048)}`;

// The ceiling past which a file is served as-is rather than compressed per request.
const COMPRESS_MAX_SIZE = 10 * 1024 * 1024;

// Ten bytes, each its own index, so a served slice reads back as its offsets.
const RANGE_BODY = "0123456789";

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

  // A nested index, reached by naming its directory rather than the file.
  await writeFile(join(dir, "sub", "index.html"), "<h1>sub index</h1>");

  // Dotfiles: bare, with an extension, nested, and inside a dot directory.
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".env"), "DOTENV");
  await writeFile(join(dir, ".env.production"), "PROD_SECRET");
  await writeFile(join(dir, "sub", ".env.local"), "LOCAL_SECRET");
  await writeFile(join(dir, ".git", "config.txt"), "GIT_CONFIG");

  // `.well-known` (RFC 8615) is allow-listed by default.
  await mkdir(join(dir, ".well-known"), { recursive: true });
  await writeFile(join(dir, ".well-known", "security.txt"), "SECURITY_TXT");

  // A dot segment nested under an allow-listed one is still a dot segment.
  await writeFile(join(dir, ".well-known", ".env"), "WELLKNOWN_SECRET");

  // A sibling that merely shares the `.well-known` prefix must not be matched.
  await mkdir(join(dir, ".well-known-backup"), { recursive: true });
  await writeFile(join(dir, ".well-known-backup", "secret.txt"), "BACKUP_SECRET");

  // Precompressed variants. Contents are markers, not real brotli/gzip: the
  // middleware serves the bytes as-is and never decompresses them.
  await writeFile(join(dir, "app.js"), "PLAIN_JS");
  await writeFile(join(dir, "app.js.br"), "BROTLI_JS");
  await writeFile(join(dir, "app.js.gz"), "GZIP_JS");
  await writeFile(join(dir, "only-gz.js"), "PLAIN_ONLY_GZ");
  await writeFile(join(dir, "only-gz.js.gz"), "GZIP_ONLY_GZ");

  // A variant with no identity file beside it.
  await writeFile(join(dir, "orphan.js.br"), "ORPHAN_BR");

  // On-the-fly compression fixtures. Everything above is deliberately under the
  // 1 KiB floor, so only these are ever encoded per request.
  //
  // `big.js` has no variant beside it: encoding it here is the only way it is
  // served compressed. `big-gz.js` has one, so it pins the precedence between
  // the two paths.
  await writeFile(join(dir, "big.js"), BIG_JS);
  await writeFile(join(dir, "big-gz.js"), BIG_JS);
  await writeFile(join(dir, "big-gz.js.gz"), BIG_GZ_MARKER);

  // The two size bounds, from either side. `truncate` extends `huge.js` with
  // zeros sparsely, so a 10 MiB size costs neither the write nor the disk.
  await writeFile(join(dir, "small.js"), "s".repeat(1023));
  await writeFile(join(dir, "huge.js"), "// huge\n");
  await truncate(join(dir, "huge.js"), COMPRESS_MAX_SIZE + 1);

  // Compressible-sized bodies behind a type and a route that must not encode.
  await writeFile(join(dir, "big.png"), BIG_JS);
  await writeFile(join(dir, "big.html"), `<h1>${"x".repeat(2048)}</h1>`);

  // A 10-byte body whose every slice is legible, for byte-range assertions.
  await writeFile(join(dir, "range.txt"), RANGE_BODY);

  // Extension-less files, reachable at their exact name.
  await writeFile(join(dir, "LICENSE"), "LICENSE_BODY");
  await writeFile(join(dir, "apple-app-site-association"), "AASA_BODY");
  await mkdir(join(dir, ".well-known", "acme-challenge"), { recursive: true });
  await writeFile(join(dir, ".well-known", "acme-challenge", "tok3n"), "ACME_KEY_AUTH");

  // An extension-less route that must still resolve to its `.html` file.
  await writeFile(join(dir, "about.html"), "<h1>about</h1>");

  // `.htm` maps to `text/html` just as `.html` does.
  await writeFile(join(dir, "page.htm"), "<h1>htm</h1>");

  // Names that only appear percent-encoded on the wire.
  await writeFile(join(dir, "hello world.txt"), "SPACE_NAME");
  await writeFile(join(dir, "café.txt"), "UNICODE_NAME");
  await writeFile(join(dir, "50%.txt"), "PERCENT_NAME");

  // Extensions whose MIME mapping is pinned below; the contents never matter.
  for (const name of ["mod.wasm", "pic.avif", "song.mp3", "bundle.gz"]) {
    await writeFile(join(dir, name), "X");
  }

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

  // Links that stay inside the root but land on a dot path: containment alone
  // serves these, since the name they are requested under has no dot segment.
  await symlink(join(dir, ".env"), join(dir, "alias-dotfile.txt"));
  await symlink(join(dir, ".git"), join(dir, "alias-dotdir"));
  await symlink(join(dir, ".well-known", "security.txt"), join(dir, "alias-allowed.txt"));

  // The same alias reached through the precompressed-variant lookup.
  await writeFile(join(dir, "alias-variant.js"), "PLAIN_ALIAS_VARIANT");
  await symlink(join(dir, ".env"), join(dir, "alias-variant.js.br"));

  // A root that is itself a symlink must keep working.
  linkedDir = join(tmp, "public-link");
  await symlink(dir, linkedDir);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init) as unknown as ServerRequest;
const notFound = () => new Response("next()", { status: 404 });

// Served bodies are backed by an open file handle that a real server drains to
// the socket. Tests that only look at the status or headers must still release
// it, or the run leaks handles until GC — so every response is registered and
// any unconsumed body cancelled after each test.
const responses: Response[] = [];
const track = async (res: Promise<Response>) => {
  const resolved = await res;
  responses.push(resolved);
  return resolved;
};
afterEach(async () => {
  for (const res of responses.splice(0)) {
    if (!res.bodyUsed) {
      // Drained, not `body.cancel()`-ed: undici does not propagate a cancel
      // to a wrapped Node readable, so only a read releases the handle.
      await res.arrayBuffer().catch(() => {});
    }
  }
});

const fetchStatic = (path: string, opts: Partial<ServeStaticOptions> = {}, init?: RequestInit) =>
  track(serveStatic({ dir, ...opts })(req(path, init), notFound) as Promise<Response>);

const fetchEncoded = (
  path: string,
  acceptEncoding: string,
  opts: Partial<ServeStaticOptions> = {},
) => fetchStatic(path, opts, { headers: { "accept-encoding": acceptEncoding } });

// The precompressed-variant lookup is opt-in (off by default), so any test that
// exercises it enables it. On-the-fly compression keeps its own default.
const fetchVariant = (
  path: string,
  acceptEncoding: string,
  opts: Partial<ServeStaticOptions> = {},
) => fetchEncoded(path, acceptEncoding, { encodings: true, ...opts });

// Every denial falls through to the app rather than being answered here, so the
// sentinel body from `notFound()` is what proves the middleware declined. It is
// strictly stronger than asserting the secret is absent.
const expectNext = async (res: Response, label?: string) => {
  expect(res.status, label).toBe(404);
  await expect(res.text()).resolves.toBe("next()");
};

// `new Request()` collapses dot segments in its constructor, so a request built
// through it hands the middleware an already-resolved pathname and can never
// exercise the containment check. `FastURL`'s origin-form fast path returns the
// target verbatim (`_searchNeedsNormRE` in `_url.ts` does not deopt on `..`),
// which is the one way an unresolved pathname reaches `static.ts` — so build
// `_url` directly to test the check rather than the test harness.
const rawReq = (path: string) => {
  const request = new Request("http://localhost/") as unknown as ServerRequest;
  request._url = new FastURL(path);
  return request;
};

const fetchRaw = (path: string) =>
  track(serveStatic({ dir })(rawReq(path), notFound) as Promise<Response>);

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

  test("serves from a dir that is a filesystem root", async () => {
    // A root already ends at a segment boundary, so the `dir + sep` prefix must
    // not become `//` — nothing would match it and every request would 404.
    // `dotfiles: true` because the host path above `tmpdir()` may itself hold a
    // dot segment (`~/.cache/...`), which is not what this pins.
    const { root } = parse(dir);
    const urlPath = "/" + relative(root, join(dir, "index.html")).split(sep).join("/");
    const res = await fetchStatic(urlPath, { dir: root, dotfiles: true });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("index");
  });

  describe("methods", () => {
    test("falls through for a method outside the default GET/HEAD", async () => {
      await expectNext(await fetchStatic("/app.js", {}, { method: "POST" }));
    });

    test("serves a method named in `methods`", async () => {
      const res = await fetchStatic("/app.js", { methods: ["POST"] }, { method: "POST" });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("matches the method case-insensitively", async () => {
      const res = await fetchStatic("/app.js", { methods: ["post"] }, { method: "POST" });
      expect(res.status).toBe(200);
    });

    test("no longer serves GET when `methods` omits it", async () => {
      await expectNext(await fetchStatic("/app.js", { methods: ["POST"] }));
    });
  });

  describe("directory routes", () => {
    test("serves <dir>/index.html for an extension-less directory route", async () => {
      const res = await fetchStatic("/sub");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("sub index");
    });

    test.each(["/sub/", "/sub//"])("serves <dir>/index.html for %s", async (path) => {
      const res = await fetchStatic(path);
      expect(res.status, path).toBe(200);
      await expect(res.text()).resolves.toContain("sub index");
    });

    test.each(["/app.js/", "/sub/inside.txt/", "/about/"])(
      "only probes the index for a slash-terminated URL (%s)",
      async (path) => {
        // `/app.js/` must not serve `app.js`, nor `/about/` serve `about.html`:
        // a directory URL names the index or nothing, or the same file gains a
        // second URL whose relative links resolve against the wrong base.
        await expectNext(await fetchStatic(path));
      },
    );
  });

  describe("symlinks", () => {
    test("does not serve a symlink escaping the root", async () => {
      await expectNext(await fetchStatic("/escape.txt"));
    });

    test("does not serve through a symlinked directory escaping the root", async () => {
      await expectNext(await fetchStatic("/escape-dir/secret.txt"));
    });

    test("serves a symlink contained within the root", async () => {
      const res = await fetchStatic("/contained.txt");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("INSIDE");
    });

    test("serves files when dir is itself a symlink", async () => {
      const res = await fetchStatic("/sub/inside.txt", { dir: linkedDir });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("INSIDE");
    });

    test("still rejects an escaping symlink when dir is itself a symlink", async () => {
      await expectNext(await fetchStatic("/escape.txt", { dir: linkedDir }));
    });

    describe("aliasing a dot path", () => {
      // The dotfile policy reads the request path, containment reads the
      // resolved one. A link inside the root that lands on a hidden dot path
      // satisfies containment, so the policy has to be re-checked after
      // resolving or the link publishes what it names.
      const DOT_ALIASES = [
        ["/alias-dotfile.txt", "DOTENV"],
        ["/alias-dotdir/config.txt", "GIT_CONFIG"],
      ];

      test.each(DOT_ALIASES)(
        "does not serve %s, which resolves onto a denied dot path",
        async (path) => {
          await expectNext(await fetchStatic(path!));
        },
      );

      test.each(DOT_ALIASES)("serves %s with dotfiles: true", async (path, contents) => {
        // The policy is what hides these, not containment: both links resolve
        // inside the root, so lifting the policy must serve them.
        await expect(fetchStatic(path!, { dotfiles: true }).then((r) => r.text())).resolves.toBe(
          contents,
        );
      });

      test("serves an alias whose target is allow-listed", async () => {
        // Resolving must re-apply the policy, not blanket-deny every link that
        // lands on a dot segment.
        const res = await fetchStatic("/alias-allowed.txt");
        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("SECURITY_TXT");
      });
    });
  });

  // `mkfifo` is POSIX-only; Windows has no FIFO to open in the first place.
  //
  // These pin the ordinary outcome — a pipe sitting in the root is refused by the
  // `stat()` mode check, before any `open()`. The harder case, where that check is
  // won by a swap and `open()` itself meets the FIFO, needs a lying `stat` to
  // reproduce and lives in `static-nonblock.test.ts`.
  describe.skipIf(process.platform === "win32")("non-regular files", () => {
    test("declines a FIFO", async () => {
      const fifo = join(dir, "pipe.txt");
      execFileSync("mkfifo", [fifo]);
      try {
        await expectNext(await fetchStatic("/pipe.txt"));
      } finally {
        await rm(fifo, { force: true });
      }
    });

    // Its own identity file rather than `app.js`, whose `.br` the shared fixture
    // already occupies.
    test("declines a FIFO standing in for a precompressed variant", async () => {
      const identity = join(dir, "piped.js");
      const fifo = `${identity}.br`;
      await writeFile(identity, "PIPED_JS");
      execFileSync("mkfifo", [fifo]);
      try {
        // The identity file still serves; only the variant is unusable.
        const res = await fetchVariant("/piped.js", "br");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe(null);
        await expect(res.text()).resolves.toBe("PIPED_JS");
      } finally {
        await rm(fifo, { force: true });
        await rm(identity, { force: true });
      }
    });
  });

  describe("dotfiles", () => {
    const DOT_PATHS = [
      ["/.env", "DOTENV"],
      ["/.env.production", "PROD_SECRET"],
      ["/sub/.env.local", "LOCAL_SECRET"],
      ["/.git/config.txt", "GIT_CONFIG"],
    ];

    test.each(DOT_PATHS)("does not serve %s by default", async (path) => {
      await expectNext(await fetchStatic(path!));
    });

    test.each(DOT_PATHS)("serves %s with dotfiles: true", async (path, contents) => {
      const res = await fetchStatic(path!, { dotfiles: true });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(contents);
    });

    test("serves an arbitrary allow-listed segment and nothing else", async () => {
      const opts = { dotfiles: [".git"] };
      const res = await fetchStatic("/.git/config.txt", opts);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("GIT_CONFIG");
      expect((await fetchStatic("/.env", opts)).status).toBe(404);
    });

    describe(".well-known", () => {
      test("is served by default", async () => {
        const res = await fetchStatic("/.well-known/security.txt");
        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("SECURITY_TXT");
      });

      test("serves an ACME challenge token by default", async () => {
        // Extension-less and under a dot directory, so this needs both the
        // literal probe and the default allow-list. Renewing a certificate must
        // not require `dotfiles: true`, which would also publish `.env`/`.git`.
        const res = await fetchStatic("/.well-known/acme-challenge/tok3n");
        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("ACME_KEY_AUTH");
      });

      test("matches by exact segment, not by prefix", async () => {
        await expectNext(await fetchStatic("/.well-known-backup/secret.txt"));
      });

      test("does not serve a dot segment nested under it", async () => {
        await expectNext(await fetchStatic("/.well-known/.env"));
      });

      test.each([
        ["false", false],
        ["[]", []],
      ])("is hidden with dotfiles: %s", async (_label, dotfiles) => {
        const res = await fetchStatic("/.well-known/security.txt", { dotfiles });
        expect(res.status).toBe(404);
      });
    });
  });

  describe("precompressed lookup (opt-in via encodings)", () => {
    // (file, Accept-Encoding) -> which bytes are served. `/app.js` has both a
    // `.br` and a `.gz` beside it; `/only-gz.js` only a `.gz`; `/index.html`
    // neither. All fixtures are under the 1 KiB floor, so on-the-fly compression
    // never fires here and the served bytes reflect the variant lookup alone.
    const VARIANT_CASES: {
      why: string;
      accept: string;
      enc: string | null;
      body: string;
      path?: string;
    }[] = [
      {
        why: "prefers brotli when both variants exist",
        accept: "gzip, br",
        enc: "br",
        body: "BROTLI_JS",
      },
      {
        why: "falls back to gzip when brotli is not accepted",
        accept: "gzip",
        enc: "gzip",
        body: "GZIP_JS",
      },
      {
        why: "falls back to the plain file when no variant is accepted",
        accept: "",
        enc: null,
        body: "PLAIN_JS",
      },
      { why: "honors q=0 as a refusal", accept: "br;q=0, gzip", enc: "gzip", body: "GZIP_JS" },
      { why: "honors an explicit q ranking", accept: "br;q=1.0", enc: "br", body: "BROTLI_JS" },
      { why: "treats a malformed q as a refusal", accept: "br;q=abc", enc: null, body: "PLAIN_JS" },
      { why: "supports the * wildcard", accept: "*", enc: "br", body: "BROTLI_JS" },
      // "x-gzip" must not satisfy "gzip", nor "brotli" satisfy "br".
      {
        why: "does not match an encoding as a substring",
        accept: "x-gzip, brotli",
        enc: null,
        body: "PLAIN_JS",
      },
      // An empty token must be skipped rather than parsed as an encoding.
      { why: "ignores empty tokens", accept: ", , br", enc: "br", body: "BROTLI_JS" },
      {
        why: "skips a missing variant and uses the next accepted one",
        accept: "br, gzip",
        enc: "gzip",
        body: "GZIP_ONLY_GZ",
        path: "/only-gz.js",
      },
      {
        why: "falls back to the plain file when no variant exists on disk",
        accept: "br",
        enc: null,
        body: "<h1>index</h1>",
        path: "/index.html",
      },
    ];

    test.each(VARIANT_CASES)("$why", async ({ accept, enc, body, path = "/app.js" }) => {
      const res = await fetchVariant(path, accept);
      expect(res.headers.get("content-encoding")).toBe(enc);
      await expect(res.text()).resolves.toBe(body);
    });

    test("is off by default, so a variant on disk is not served", async () => {
      // `/app.js` (8 bytes) has a `.br` beside it, but without `encodings` the
      // lookup never runs and the file is under the on-the-fly floor, so the
      // plain bytes are what come back.
      const res = await fetchEncoded("/app.js", "br");
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("sets Vary: Accept-Encoding on a variant response and its identity", async () => {
      expect((await fetchVariant("/app.js", "br")).headers.get("vary")).toBe("Accept-Encoding");
      // Also on the uncompressed response: caches must key on the header.
      expect((await fetchVariant("/index.html", "")).headers.get("vary")).toBe("Accept-Encoding");
    });

    test("sets Content-Length to the served variant's size", async () => {
      const res = await fetchVariant("/app.js", "br");
      expect(res.headers.get("content-length")).toBe(String("BROTLI_JS".length));
    });

    test("skips the lookup with encodings: {}", async () => {
      // `{}` is as explicit an off as the default. `/app.js` is under the floor,
      // so with no lookup there is nothing left to serve but the plain bytes.
      const res = await fetchEncoded("/app.js", "br", { encodings: {} });
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("ignores a variant with no identity file beside it", async () => {
      // The identity file gates the lookup, so an orphan `.br` is not a route.
      // Nothing is lost: a client accepting no encoding could not be served it
      // anyway, so shipping one without its source is already a broken deploy.
      await expectNext(await fetchVariant("/orphan.js", "br"));
    });

    test.each([
      // Links out of the root, and onto a denied dot path respectively. Both
      // plain files stay put, and a variant that is not servable is skipped
      // rather than fatal — the identity file below it still serves.
      ["/escape-variant.js", "PLAIN_VARIANT", "TOPSECRET"],
      ["/alias-variant.js", "PLAIN_ALIAS_VARIANT", "DOTENV"],
    ])(
      "falls back to the plain file when %s's variant is not servable",
      async (path, body, secret) => {
        const res = await fetchVariant(path!, "br");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe(null);
        const text = await res.text();
        expect(text).toBe(body);
        expect(text).not.toContain(secret);
      },
    );
  });

  describe("on-the-fly compression", () => {
    const decode: Record<string, (buf: Buffer) => Buffer> = {
      br: brotliDecompressSync,
      gzip: gunzipSync,
    };

    test.each(["br", "gzip"])("encodes with %s when no variant exists", async (enc) => {
      const res = await fetchEncoded("/big.js", enc);
      expect(res.headers.get("content-encoding")).toBe(enc);
      // Decoding the body is what proves it was really encoded, rather than the
      // plain bytes sent under an encoding header.
      const body = Buffer.from(await res.arrayBuffer());
      expect(decode[enc]!(body).toString()).toBe(BIG_JS);
      expect(body.length).toBeLessThan(BIG_JS.length);
    });

    test("prefers brotli over gzip", async () => {
      const res = await fetchEncoded("/big.js", "gzip, br");
      expect(res.headers.get("content-encoding")).toBe("br");
    });

    test("honors q=0 as a refusal", async () => {
      const res = await fetchEncoded("/big.js", "br;q=0, gzip");
      expect(res.headers.get("content-encoding")).toBe("gzip");
    });

    test("omits Content-Length, unknown until the bytes are encoded", async () => {
      const res = await fetchEncoded("/big.js", "br");
      expect(res.headers.get("content-length")).toBe(null);
    });

    test("sets Vary: Accept-Encoding", async () => {
      expect((await fetchEncoded("/big.js", "br")).headers.get("vary")).toBe("Accept-Encoding");
    });

    test("prefers a variant on disk over encoding on the fly", async () => {
      // `/big-gz.js` is over the floor and has a `.gz` beside it. Brotli is
      // accepted and ranks first, but a variant costs no CPU, so the `.gz` wins
      // — and its marker contents are what prove it was not encoded here. Both
      // the variant and the file under it are over the floor, so nothing but
      // precedence decides this. The lookup is opt-in, hence `encodings: true`.
      const res = await fetchVariant("/big-gz.js", "br, gzip");
      expect(res.headers.get("content-encoding")).toBe("gzip");
      await expect(res.text()).resolves.toBe(BIG_GZ_MARKER);
    });

    test.each([
      ["under the size floor", "/small.js"],
      ["over the size ceiling", "/huge.js"],
    ])("serves a file %s as-is", async (_why, path) => {
      const res = await fetchEncoded(path!, "br");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe(null);
      // Unencoded, so the length is known and must still be declared.
      expect(res.headers.get("content-length")).not.toBe(null);
    });

    test("never encodes an already-compressed type", async () => {
      const res = await fetchEncoded("/big.png", "br");
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(res.headers.get("vary")).toBe(null);
      await expect(res.text()).resolves.toBe(BIG_JS);
    });

    test("does not encode a renderHTML route", async () => {
      // The rendered `Response` belongs to the caller; encoding it would mean
      // rewriting a body this middleware does not own.
      const res = await fetchStatic(
        "/big.html",
        { renderHTML: ({ html }: { html: string }) => new Response(html) },
        { headers: { "accept-encoding": "br" } },
      );
      expect(res.headers.get("content-encoding")).toBe(null);
    });

    test("serves the plain file with compress: false", async () => {
      const res = await fetchEncoded("/big.js", "br", { compress: false });
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe(BIG_JS);
    });

    test("encodes without probing the disk with encodings: {}", async () => {
      // `/big-gz.js` has a `.gz` the lookup would have served. With no encodings
      // configured there is no lookup, so the response is encoded here instead —
      // which the disk variant's marker contents would give away.
      const res = await fetchEncoded("/big-gz.js", "gzip", { encodings: {} });
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(BIG_JS);
    });

    test("serves nothing encoded with encodings: {} and compress: false", async () => {
      const res = await fetchEncoded("/big.js", "br", { encodings: {}, compress: false });
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(res.headers.get("vary")).toBe(null);
      await expect(res.text()).resolves.toBe(BIG_JS);
    });

    test("reports HEAD headers without encoding a body", async () => {
      const res = await fetchStatic(
        "/big.js",
        {},
        { method: "HEAD", headers: { "accept-encoding": "br" } },
      );
      // Exactly what GET would send: encoded, and chunked rather than declaring
      // a length...
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-length")).toBe(null);
      // ...except that the bytes are never produced.
      await expect(res.text()).resolves.toBe("");
    });
  });

  describe("extension-less paths", () => {
    test.each([
      ["/LICENSE", "LICENSE_BODY"],
      ["/apple-app-site-association", "AASA_BODY"],
    ])("serves %s at its exact name", async (path, contents) => {
      const res = await fetchStatic(path!);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(contents);
    });

    test("still resolves an extension-less route to its .html file", async () => {
      const res = await fetchStatic("/about");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("about");
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
  });

  describe("renderHTML", () => {
    const opts = {
      renderHTML: ({ html }: { html: string }) => new Response(`${html}<!--rendered-->`),
    };

    test.each(["/index.html", "/page.htm"])("renders %s", async (path) => {
      // Both map to `text/html`, so both render: an extension the MIME table
      // treats as HTML must not be served as raw markup.
      const res = await fetchStatic(path, opts);
      await expect(res.text()).resolves.toContain("<!--rendered-->");
    });

    test("does not render a non-HTML file", async () => {
      const res = await fetchStatic("/sub/inside.txt", opts);
      await expect(res.text()).resolves.toBe("INSIDE");
    });
  });

  describe("Content-Type", () => {
    test.each([
      // Text carries an explicit charset...
      ["/index.html", "text/html; charset=utf-8"],
      ["/sub/inside.txt", "text/plain; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      // ...while non-text bytes have none to declare.
      ["/logo.png", "image/png"],
      ["/LICENSE", "application/octet-stream"],
      // Straight from the MIME table.
      ["/mod.wasm", "application/wasm"],
      ["/pic.avif", "image/avif"],
      ["/song.mp3", "audio/mpeg"],
      ["/bundle.gz", "application/gzip"],
    ])("declares %s as %s", async (path, type) => {
      expect((await fetchStatic(path!)).headers.get("content-type")).toBe(type);
    });

    test("declares a charset alongside Content-Encoding", async () => {
      // The charset describes the decoded bytes, so a variant keeps it.
      const res = await fetchVariant("/app.js", "br");
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(res.headers.get("content-encoding")).toBe("br");
    });
  });

  describe("caching validators", () => {
    test("sets a weak ETag and Last-Modified by default", async () => {
      const res = await fetchStatic("/app.js");
      expect(res.headers.get("etag")).toMatch(/^W\/".+"$/);
      // A parseable HTTP date, not the raw mtime.
      expect(Number.isNaN(Date.parse(res.headers.get("last-modified")!))).toBe(false);
    });

    test("answers a matching If-None-Match with 304 and no body", async () => {
      const etag = (await fetchStatic("/app.js")).headers.get("etag")!;
      const res = await fetchStatic("/app.js", {}, { headers: { "if-none-match": etag } });
      expect(res.status).toBe(304);
      // The validator is echoed so the client can refresh its freshness...
      expect(res.headers.get("etag")).toBe(etag);
      // ...but the representation headers are not, and there is no body.
      expect(res.headers.get("content-length")).toBe(null);
      await expect(res.text()).resolves.toBe("");
    });

    test("serves the body when If-None-Match does not match", async () => {
      const res = await fetchStatic("/app.js", {}, { headers: { "if-none-match": 'W/"stale"' } });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("treats If-None-Match: * as a match", async () => {
      const res = await fetchStatic("/app.js", {}, { headers: { "if-none-match": "*" } });
      expect(res.status).toBe(304);
    });

    test("answers a fresh If-Modified-Since with 304", async () => {
      const lastModified = (await fetchStatic("/app.js")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/app.js",
        {},
        { headers: { "if-modified-since": lastModified } },
      );
      expect(res.status).toBe(304);
      await expect(res.text()).resolves.toBe("");
    });

    test("serves the body when If-Modified-Since predates the file", async () => {
      const res = await fetchStatic(
        "/app.js",
        {},
        { headers: { "if-modified-since": new Date(0).toUTCString() } },
      );
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("lets a non-matching If-None-Match override a fresh If-Modified-Since", async () => {
      // RFC 9110 §13.2.2: If-None-Match present and unmatched is final; the fresh
      // If-Modified-Since here must not rescue it into a 304.
      const lastModified = (await fetchStatic("/app.js")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/app.js",
        {},
        { headers: { "if-none-match": 'W/"stale"', "if-modified-since": lastModified } },
      );
      expect(res.status).toBe(200);
    });

    test("gives distinct ETags to distinct encodings of one file", async () => {
      // Same file, so same size and mtime — only the folded-in encoding sets the
      // two tags apart, which a cache keying on Vary depends on.
      const identity = (await fetchEncoded("/big.js", "")).headers.get("etag")!;
      const gzip = await fetchEncoded("/big.js", "gzip");
      expect(gzip.headers.get("content-encoding")).toBe("gzip");
      expect(gzip.headers.get("etag")).not.toBe(identity);

      // The identity tag must not validate the gzip representation...
      const wrongRes = await fetchStatic(
        "/big.js",
        {},
        { headers: { "accept-encoding": "gzip", "if-none-match": identity } },
      );
      expect(wrongRes.status).toBe(200);
      // ...while the gzip tag does, and the 304 still carries Vary.
      const gzipEtag = gzip.headers.get("etag")!;
      const right = await fetchStatic(
        "/big.js",
        {},
        { headers: { "accept-encoding": "gzip", "if-none-match": gzipEtag } },
      );
      expect(right.status).toBe(304);
      expect(right.headers.get("vary")).toBe("Accept-Encoding");
    });

    test("omits ETag and does not match a client tag with etag: false", async () => {
      const res = await fetchStatic("/app.js", { etag: false });
      expect(res.headers.get("etag")).toBe(null);
      // With no tag emitted, a specific If-None-Match cannot match, so the tag
      // a default run would have minted no longer 304s. (`*` is the one value
      // that still matches — it asks only whether a representation exists.)
      const cond = await fetchStatic(
        "/app.js",
        { etag: false },
        { headers: { "if-none-match": 'W/"whatever"' } },
      );
      expect(cond.status).toBe(200);
    });

    test("omits Last-Modified and ignores If-Modified-Since with lastModified: false", async () => {
      const res = await fetchStatic("/app.js", { lastModified: false });
      expect(res.headers.get("last-modified")).toBe(null);
      const cond = await fetchStatic(
        "/app.js",
        { lastModified: false },
        { headers: { "if-modified-since": new Date(Date.now() + 3600_000).toUTCString() } },
      );
      expect(cond.status).toBe(200);
    });

    test("does not set validators on a renderHTML route", async () => {
      const res = await fetchStatic("/index.html", {
        renderHTML: ({ html }: { html: string }) => new Response(html),
      });
      expect(res.headers.get("etag")).toBe(null);
      expect(res.headers.get("last-modified")).toBe(null);
    });

    test("answers a matching If-None-Match on a non-GET/HEAD method with 412", async () => {
      // The tag is stable across methods (size + mtime), so a default GET mints
      // the one a configured POST must fail its precondition against.
      const etag = (await fetchStatic("/app.js")).headers.get("etag")!;
      const res = await fetchStatic(
        "/app.js",
        { methods: ["POST"] },
        { method: "POST", headers: { "if-none-match": etag } },
      );
      expect(res.status).toBe(412);
      expect(res.headers.get("etag")).toBe(etag);
      await expect(res.text()).resolves.toBe("");
    });

    test("serves a non-GET/HEAD body when If-None-Match does not match", async () => {
      const res = await fetchStatic(
        "/app.js",
        { methods: ["POST"] },
        { method: "POST", headers: { "if-none-match": 'W/"stale"' } },
      );
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("ignores If-Modified-Since for a non-GET/HEAD method", async () => {
      // A GET/HEAD-only validator (RFC 9110 §13.1.3): a fresh date must not
      // shortcut a configured POST into a 304.
      const lastModified = (await fetchStatic("/app.js")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/app.js",
        { methods: ["POST"] },
        { method: "POST", headers: { "if-modified-since": lastModified } },
      );
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("PLAIN_JS");
    });

    test("If-None-Match presence suppresses If-Modified-Since even with etag off", async () => {
      // RFC 9110 §13.2.2: a present If-None-Match takes precedence. With
      // `etag: false` no tag is emitted, so a specific one cannot match — the
      // full body is served, not a 304 rescued by the still-parsed date.
      const lastModified = (await fetchStatic("/app.js")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/app.js",
        { etag: false },
        { headers: { "if-none-match": 'W/"whatever"', "if-modified-since": lastModified } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe(null);
    });

    test("still honors If-Modified-Since with etag off when no If-None-Match is sent", async () => {
      // Nothing suppresses the date check here, so the date validator alone
      // still shortcuts to a 304.
      const lastModified = (await fetchStatic("/app.js")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/app.js",
        { etag: false },
        { headers: { "if-modified-since": lastModified } },
      );
      expect(res.status).toBe(304);
    });

    test("caps Last-Modified at the response time for a future-dated file", async () => {
      // A future mtime (clock skew, a deliberately post-dated file) must not
      // surface as a future `Last-Modified` — RFC 9110 §8.8.2 — or an
      // `If-Modified-Since` bearing it would 304 until real time catches up.
      const future = join(dir, "future.js");
      await writeFile(future, "FUTURE");
      const ahead = new Date(Date.now() + 86_400_000);
      await utimes(future, ahead, ahead);
      try {
        const res = await fetchStatic("/future.js");
        expect(Date.parse(res.headers.get("last-modified")!)).toBeLessThanOrEqual(Date.now());
      } finally {
        await rm(future, { force: true });
      }
    });

    test("answers a conditional HEAD with 304", async () => {
      const etag = (await fetchStatic("/app.js")).headers.get("etag")!;
      const res = await fetchStatic(
        "/app.js",
        {},
        { method: "HEAD", headers: { "if-none-match": etag } },
      );
      expect(res.status).toBe(304);
      await expect(res.text()).resolves.toBe("");
    });
  });

  describe("Cache-Control", () => {
    test("omits the header by default", async () => {
      const res = await fetchStatic("/app.js");
      expect(res.headers.get("cache-control")).toBe(null);
    });

    test("emits max-age from maxAge (seconds)", async () => {
      const res = await fetchStatic("/app.js", { maxAge: 3600 });
      expect(res.headers.get("cache-control")).toBe("max-age=3600");
    });

    test("adds immutable alongside maxAge", async () => {
      const res = await fetchStatic("/app.js", { maxAge: 31536000, immutable: true });
      expect(res.headers.get("cache-control")).toBe("max-age=31536000, immutable");
    });

    test("floors a fractional maxAge and clamps a negative one to 0", async () => {
      expect((await fetchStatic("/app.js", { maxAge: 59.9 })).headers.get("cache-control")).toBe(
        "max-age=59",
      );
      expect((await fetchStatic("/app.js", { maxAge: -10 })).headers.get("cache-control")).toBe(
        "max-age=0",
      );
    });

    test("falls back to 0 for non-finite maxAge and caps huge values", async () => {
      expect((await fetchStatic("/app.js", { maxAge: NaN })).headers.get("cache-control")).toBe(
        "max-age=0",
      );
      expect(
        (await fetchStatic("/app.js", { maxAge: Infinity })).headers.get("cache-control"),
      ).toBe("max-age=0");
      expect((await fetchStatic("/app.js", { maxAge: 1e21 })).headers.get("cache-control")).toBe(
        "max-age=2147483648",
      );
    });

    test("ignores immutable without a maxAge", async () => {
      const res = await fetchStatic("/app.js", { immutable: true });
      expect(res.headers.get("cache-control")).toBe(null);
    });

    test("carries Cache-Control on a 304 but not a 412", async () => {
      const etag = (await fetchStatic("/app.js", { maxAge: 600 })).headers.get("etag")!;
      const notModified = await fetchStatic(
        "/app.js",
        { maxAge: 600 },
        { headers: { "if-none-match": etag } },
      );
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("cache-control")).toBe("max-age=600");

      const precondition = await fetchStatic(
        "/app.js",
        { maxAge: 600, methods: ["POST"] },
        { method: "POST", headers: { "if-none-match": etag } },
      );
      expect(precondition.status).toBe(412);
      expect(precondition.headers.get("cache-control")).toBe(null);
    });

    test("sets Cache-Control on a HEAD response", async () => {
      const res = await fetchStatic("/app.js", { maxAge: 120 }, { method: "HEAD" });
      expect(res.headers.get("cache-control")).toBe("max-age=120");
    });

    test("does not set Cache-Control on a renderHTML route", async () => {
      const res = await fetchStatic("/index.html", {
        maxAge: 3600,
        renderHTML: ({ html }: { html: string }) => new Response(html),
      });
      expect(res.headers.get("cache-control")).toBe(null);
    });
  });

  describe("HEAD", () => {
    test("returns headers with no body", async () => {
      const res = await fetchStatic("/app.js", {}, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String("PLAIN_JS".length));
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      await expect(res.text()).resolves.toBe("");
    });

    test("reports the variant's headers without a body", async () => {
      const res = await fetchStatic(
        "/app.js",
        { encodings: true },
        { method: "HEAD", headers: { "accept-encoding": "br" } },
      );
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-length")).toBe(String("BROTLI_JS".length));
      await expect(res.text()).resolves.toBe("");
    });

    test("returns no body for a renderHTML route", async () => {
      const opts = {
        renderHTML: ({ html }: { html: string }) =>
          new Response(`${html}<!--rendered-->`, { headers: { "x-rendered": "1" } }),
      };
      const get = await fetchStatic("/index.html", opts);
      await expect(get.text()).resolves.toContain("<!--rendered-->");

      const head = await fetchStatic("/index.html", opts, { method: "HEAD" });
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
      const head = await fetchStatic("/index.html", opts, { method: "HEAD" });
      await expect(head.text()).resolves.toBe("");
      expect(cancelled).toBe(true);
    });
  });

  describe("percent-encoded paths", () => {
    test.each([
      ["/hello%20world.txt", "SPACE_NAME"],
      ["/caf%C3%A9.txt", "UNICODE_NAME"],
      ["/50%25.txt", "PERCENT_NAME"],
    ])("decodes %s exactly once for the lookup", async (path, contents) => {
      const res = await fetchStatic(path!);
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(contents);
    });

    test.each([
      // The decoded lookup is for a file literally named `sub%2Finside.txt`.
      "/sub%2Finside.txt",
      // `%2f` survives `decodeURI`, so this stays a single literal filename
      // rather than traversing. Reaches the middleware verbatim: `new Request()`
      // only collapses real separators.
      "/%2e%2e%2foutside%2fsecret.txt",
    ])("keeps the encoded separator in %s encoded", async (path) => {
      await expectNext(await fetchStatic(path), path);
    });

    test("applies the dotfile policy to the decoded name", async () => {
      expect((await fetchStatic("/%2Eenv")).status).toBe(404);
      await expect(fetchStatic("/%2Eenv", { dotfiles: true }).then((r) => r.text())).resolves.toBe(
        "DOTENV",
      );
    });

    test("applies the dotfile allow-list to the decoded name", async () => {
      // The allow-list is matched after decoding, so an encoded `.well-known`
      // is neither denied as an unknown dot segment nor let through unchecked.
      await expect(fetchStatic("/%2Ewell-known/security.txt").then((r) => r.text())).resolves.toBe(
        "SECURITY_TXT",
      );
      expect((await fetchStatic("/%2Ewell-known/%2Eenv")).status).toBe(404);
    });

    test("does not decode twice", async () => {
      // `%252e%252e` decodes once to the harmless literal `%2e%2e`.
      await expectNext(await fetchStatic("/%252e%252e/outside/secret.txt"));
    });

    test.each(["/foo%", "/%ZZ"])("rejects the malformed encoding %s with 400", async (path) => {
      expect((await fetchStatic(path)).status, path).toBe(400);
    });
  });

  describe("byte ranges", () => {
    const fetchRange = (path: string, range: string, opts: Partial<ServeStaticOptions> = {}) =>
      fetchStatic(path, opts, { headers: { range } });

    test("serves a leading slice as 206", async () => {
      const res = await fetchRange("/range.txt", "bytes=0-4");
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-4/${RANGE_BODY.length}`);
      expect(res.headers.get("content-length")).toBe("5");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      await expect(res.text()).resolves.toBe("01234");
    });

    test("serves an open-ended range to the end", async () => {
      const res = await fetchRange("/range.txt", "bytes=5-");
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 5-9/${RANGE_BODY.length}`);
      await expect(res.text()).resolves.toBe("56789");
    });

    test("serves a suffix range of the last N bytes", async () => {
      const res = await fetchRange("/range.txt", "bytes=-5");
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 5-9/${RANGE_BODY.length}`);
      await expect(res.text()).resolves.toBe("56789");
    });

    test("clamps an end past the file to the last byte", async () => {
      const res = await fetchRange("/range.txt", "bytes=0-999999");
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-9/${RANGE_BODY.length}`);
      expect(res.headers.get("content-length")).toBe(String(RANGE_BODY.length));
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("caps a suffix larger than the file at the whole file", async () => {
      const res = await fetchRange("/range.txt", "bytes=-999999");
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 0-9/${RANGE_BODY.length}`);
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test.each([
      ["a multi-range set", "bytes=0-1,5-6"],
      ["a non-numeric range", "bytes=abc"],
      ["an inverted range", "bytes=5-2"],
    ])("ignores %s and serves the full 200", async (_why, range) => {
      const res = await fetchRange("/range.txt", range);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("ignores a non-bytes unit without disturbing negotiation", async () => {
      // Not a range request at all, so the normal on-the-fly encoding still runs.
      const res = await fetchStatic(
        "/big.js",
        {},
        { headers: { range: "items=0-1", "accept-encoding": "br" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      expect(res.headers.get("content-encoding")).toBe("br");
    });

    test.each([
      ["a start past the file", "bytes=999999-"],
      ["a zero-length suffix", "bytes=-0"],
    ])("answers %s with 416", async (_why, range) => {
      const res = await fetchRange("/range.txt", range);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${RANGE_BODY.length}`);
      // A 416 is a plain error: no validators or representation headers ride it.
      expect(res.headers.get("etag")).toBe(null);
      expect(res.headers.get("last-modified")).toBe(null);
      await expect(res.text()).resolves.toBe("");
    });

    test("applies the range when If-Range matches Last-Modified", async () => {
      const lastModified = (await fetchStatic("/range.txt")).headers.get("last-modified")!;
      const res = await fetchStatic(
        "/range.txt",
        {},
        { headers: { range: "bytes=0-4", "if-range": lastModified } },
      );
      expect(res.status).toBe(206);
      await expect(res.text()).resolves.toBe("01234");
    });

    test("serves the full 200 when If-Range is not an HTTP-date", async () => {
      // Strong date comparison, taken literally: only the IMF-fixdate emitted as
      // `Last-Modified` matches, so an ISO timestamp naming the same second —
      // which `Date.parse` would happily read — does not revalidate the range.
      const lastModified = (await fetchStatic("/range.txt")).headers.get("last-modified")!;
      const iso = new Date(lastModified).toISOString();
      const res = await fetchStatic(
        "/range.txt",
        {},
        { headers: { range: "bytes=0-4", "if-range": iso } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("serves the full 200 when If-Range is a stale date", async () => {
      const res = await fetchStatic(
        "/range.txt",
        {},
        { headers: { range: "bytes=0-4", "if-range": new Date(0).toUTCString() } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("serves the full 200 when If-Range carries the weak ETag", async () => {
      // Our tags are weak, and If-Range demands a strong comparison, so an
      // entity-tag If-Range never matches — the whole representation is served.
      const etag = (await fetchStatic("/range.txt")).headers.get("etag")!;
      expect(etag).toMatch(/^W\//);
      const res = await fetchStatic(
        "/range.txt",
        {},
        { headers: { range: "bytes=0-4", "if-range": etag } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("ignores the Range header on a HEAD request", async () => {
      const res = await fetchStatic(
        "/range.txt",
        {},
        { method: "HEAD", headers: { range: "bytes=0-4" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      expect(res.headers.get("content-length")).toBe(String(RANGE_BODY.length));
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      await expect(res.text()).resolves.toBe("");
    });

    test("serves identity bytes for a range on a compressible file", async () => {
      // A range bypasses negotiation: the client accepts br/gzip, but the 206 is
      // the raw bytes with no Content-Encoding.
      const res = await fetchStatic(
        "/big.js",
        {},
        { headers: { range: "bytes=0-9", "accept-encoding": "br, gzip" } },
      );
      expect(res.status).toBe(206);
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      await expect(res.text()).resolves.toBe(BIG_JS.slice(0, 10));
    });

    test("ignores a precompressed variant for a range request", async () => {
      // `/big-gz.js` has a `.gz` beside it and the lookup is enabled, but a range
      // is served identity-only — the disk variant's marker never appears.
      const res = await fetchStatic(
        "/big-gz.js",
        { encodings: true },
        { headers: { range: "bytes=0-9", "accept-encoding": "br, gzip" } },
      );
      expect(res.status).toBe(206);
      expect(res.headers.get("content-encoding")).toBe(null);
      await expect(res.text()).resolves.toBe(BIG_JS.slice(0, 10));
    });

    test("lets a matching If-None-Match 304 win over the Range", async () => {
      const etag = (await fetchStatic("/range.txt")).headers.get("etag")!;
      const res = await fetchStatic(
        "/range.txt",
        {},
        { headers: { "if-none-match": etag, range: "bytes=0-4" } },
      );
      expect(res.status).toBe(304);
      expect(res.headers.get("content-range")).toBe(null);
      await expect(res.text()).resolves.toBe("");
    });

    test("serves the full 200 for a range request with ranges: false", async () => {
      const res = await fetchRange("/range.txt", "bytes=0-4", { ranges: false });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe(null);
      expect(res.headers.get("accept-ranges")).toBe(null);
      await expect(res.text()).resolves.toBe(RANGE_BODY);
    });

    test("advertises Accept-Ranges on an identity 200 but not a compressed one", async () => {
      expect((await fetchStatic("/range.txt")).headers.get("accept-ranges")).toBe("bytes");
      // An on-the-fly encoded response omits it.
      const encoded = await fetchEncoded("/big.js", "br");
      expect(encoded.headers.get("content-encoding")).toBe("br");
      expect(encoded.headers.get("accept-ranges")).toBe(null);
      // As does a precompressed variant.
      const variant = await fetchVariant("/app.js", "br");
      expect(variant.headers.get("accept-ranges")).toBe(null);
    });
  });

  describe("unresolved pathname", () => {
    // Every request here bypasses `new Request()` — see `rawReq`. Without that,
    // the pathname arrives already collapsed and these assert nothing: they pass
    // against a `serveStatic` with both containment checks deleted.
    test.each([
      "/../outside/secret.txt",
      "/sub/../../outside/secret.txt",
      "/../../../../../../etc/passwd",
      // A traversal that starts inside an allow-listed dot segment.
      "/.well-known/../../outside/secret.txt",
    ])("serves no traversal from a raw %s", async (path) => {
      await expectNext(await fetchRaw(path), path);
    });

    test.each(["/sub/../index.html", "/./index.html"])(
      "serves %s, which resolves back inside the root",
      async (path) => {
        // Not every dot segment escapes, and `join()` collapses these before the
        // dotfile check, so they must not be read as dotfiles either.
        const res = await fetchRaw(path);
        expect(res.status, path).toBe(200);
        await expect(res.text()).resolves.toContain("index");
      },
    );
  });
});
