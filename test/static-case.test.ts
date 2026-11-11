import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { lstatSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ServerRequest } from "../src/types.ts";

// A case-insensitive filesystem (default macOS, Windows) cannot be created on a
// Linux CI box, so one is emulated under the fixture root: a path segment with no
// exact match on disk opens the entry that matches it case-insensitively, and
// `realpath` reports the spelling stored on disk, as macOS `realpath(3)` and
// Windows `GetFinalPathNameByHandleW` do. The files themselves are real; only
// the lookup of `open`, `stat` and `realpath` is folded. Exact matches win, so
// every path that exists as spelled behaves exactly as on the real disk.
//
// That models APFS and NTFS, which keep each name as created. With `hfs` set,
// `realpath` also returns every name decomposed (NFD), as HFS+ stores them.
// With `foldFrom` set, only lookups inside that directory fold, as on Windows,
// where case sensitivity is a per-directory setting.
const fixture = { root: "", foldFrom: "", hfs: false, lstats: [] as string[] };

const foldName = (s: string) => s.normalize("NFC").toLowerCase();

const resolveFolded = (path: string): string => {
  if (!fixture.root || !path.startsWith(fixture.root + sep)) {
    return path;
  }
  let current = fixture.root;
  for (const segment of path.slice(fixture.root.length + 1).split(sep)) {
    const exact = join(current, segment);
    let found: string | undefined;
    try {
      lstatSync(exact);
      found = exact;
    } catch {
      const foldFrom = fixture.foldFrom || fixture.root;
      try {
        if (current !== foldFrom && !current.startsWith(foldFrom + sep)) {
          throw new Error("case-sensitive directory");
        }
        const match = readdirSync(current).find((e) => foldName(e) === foldName(segment));
        found = match === undefined ? undefined : join(current, match);
      } catch {
        // `current` is not a directory: the open below fails as it would.
      }
    }
    current = found ?? exact;
  }
  return current;
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: ((path: string, ...rest: [never]) =>
      actual.open(resolveFolded(path), ...rest)) as typeof actual.open,
    stat: ((path: string, ...rest: [never]) =>
      actual.stat(resolveFolded(path), ...rest)) as typeof actual.stat,
    lstat: ((path: string, ...rest: [never]) => {
      fixture.lstats.push(path);
      return actual.lstat(resolveFolded(path), ...rest);
    }) as typeof actual.lstat,
    realpath: (async (path: string, ...rest: [never]) => {
      const real = await actual.realpath(resolveFolded(path), ...rest);
      return fixture.hfs ? real.normalize("NFD") : real;
    }) as typeof actual.realpath,
  };
});

const { staticMiddleware } = await import("../src/static.ts");
const { departingPrefix, isSpellingAlias } = await import("../src/_static-alias.ts");
type Options = Parameters<typeof staticMiddleware>[0];

let tmp: string;
let dir: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "srvx-static-case-"));
  fixture.root = tmp;
  dir = join(tmp, "public");
  await mkdir(join(dir, "admin"), { recursive: true });
  await writeFile(join(dir, "admin", "x.txt"), "ADMIN_X");
  await mkdir(join(dir, "Key"), { recursive: true });
  await writeFile(join(dir, "Key", "x.txt"), "KEY_X");
  await writeFile(join(dir, "app.js"), "PLAIN_JS");
  await writeFile(join(dir, "app.js.br"), "BROTLI_JS");
  // A variant stored under another case than its identity file.
  await writeFile(join(dir, "skew.js"), "PLAIN_SKEW");
  await writeFile(join(dir, "Skew.js.br"), "BROTLI_SKEW");
  await writeFile(join(dir, "about.html"), "<h1>about</h1>");
  // Names the middleware completes (index, `.html`, a variant's extension),
  // stored in another case than it appends them.
  await writeFile(join(dir, "Index.html"), "<h1>root index</h1>");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "INDEX.HTML"), "<h1>docs index</h1>");
  await writeFile(join(dir, "page.HTML"), "<h1>page</h1>");
  await writeFile(join(dir, "logo.js"), "PLAIN_LOGO");
  await writeFile(join(dir, "logo.js.BR"), "BROTLI_LOGO");
  await writeFile(join(dir, ".env"), "DOTENV");
  // `café.txt` stored decomposed (NFD), as HFS+ and some macOS tools write it.
  await writeFile(join(dir, "cafe\u0301.txt"), "NFD_NAME");
  // `naïve.txt` stored composed (NFC), which HFS+ would report decomposed.
  await writeFile(join(dir, "na\u00efve.txt"), "NFC_NAME");
  // In-root links: one to a file, one to a directory.
  await symlink(join(dir, "admin", "x.txt"), join(dir, "link.txt"));
  await symlink(join(dir, "admin"), join(dir, "admin-link"));
  await writeFile(join(dir, "README.txt"), "README");
  await symlink(join(dir, "README.txt"), join(dir, "Readme.txt"));
  await symlink(join(dir, ".env"), join(dir, "env-alias.txt"));
  await mkdir(join(tmp, "outside"), { recursive: true });
  await writeFile(join(tmp, "outside", "secret.txt"), "TOPSECRET");
  await symlink(join(tmp, "outside", "secret.txt"), join(dir, "escape.txt"));
});

afterAll(async () => {
  fixture.root = "";
  await rm(tmp, { recursive: true, force: true });
});

const fetchStatic = (path: string, opts: Partial<Options> = {}, init?: RequestInit) =>
  staticMiddleware({ dir, ...opts })(
    new Request(`http://localhost${path}`, init) as unknown as ServerRequest,
    () => new Response("next()", { status: 404 }),
  ) as Promise<Response>;

const expectServed = async (res: Response, body: string) => {
  expect(res.status).toBe(200);
  await expect(res.text()).resolves.toBe(body);
};

const expectNext = async (res: Response) => {
  expect(res.status).toBe(404);
  await expect(res.text()).resolves.toBe("next()");
};

describe("static on a case-insensitive filesystem", () => {
  test("the emulation opens a differently cased spelling", async () => {
    // Guards the mock: if this broke, the refusals below would pass because
    // the file was never found, not because the middleware declined it.
    const { open } = await import("node:fs/promises");
    const handle = await open(join(dir, "ADMIN", "X.TXT"));
    await expect(handle.readFile("utf8")).resolves.toBe("ADMIN_X");
    await handle.close();
  });

  test("a hit at the on-disk case adds no syscall", async () => {
    fixture.lstats.length = 0;
    await expectServed(await fetchStatic("/admin/x.txt"), "ADMIN_X");
    await expectServed(await fetchStatic("/link.txt"), "ADMIN_X");
    expect(fixture.lstats).toEqual([]);
  });

  test("falls through when only the served root folds case, not its parent", async () => {
    fixture.foldFrom = dir;
    try {
      await expectServed(await fetchStatic("/admin/x.txt"), "ADMIN_X");
      await expectNext(await fetchStatic("/ADMIN/x.txt"));
    } finally {
      fixture.foldFrom = "";
    }
  });

  test("tells a case-only link from an alias per directory", async () => {
    // The root is case-sensitive and holds `Readme.txt` -> `README.txt`; only
    // `admin/` folds case.
    fixture.foldFrom = join(dir, "admin");
    try {
      await expectServed(await fetchStatic("/Readme.txt"), "README");
      await expectServed(await fetchStatic("/README.txt"), "README");
      await expectNext(await fetchStatic("/admin/X.TXT"));
    } finally {
      fixture.foldFrom = "";
    }
  });

  test("serves a file at its on-disk case", async () => {
    await expectServed(await fetchStatic("/admin/x.txt"), "ADMIN_X");
  });

  test.each(["/ADMIN/x.txt", "/admin/X.txt", "/Admin/X.TXT", "/ABOUT", "/About.html"])(
    "falls through for the differently cased %s",
    async (path) => {
      await expectNext(await fetchStatic(path));
    },
  );

  test("falls through for a KELVIN SIGN standing in for K", async () => {
    await expectServed(await fetchStatic("/Key/x.txt"), "KEY_X");
    await expectNext(await fetchStatic("/%E2%84%AAey/x.txt"));
  });

  test("serves a name under either Unicode normalization", async () => {
    // Stored decomposed: browsers send the composed form.
    await expectServed(await fetchStatic("/cafe%CC%81.txt"), "NFD_NAME");
    await expectServed(await fetchStatic("/caf%C3%A9.txt"), "NFD_NAME");
    await expectNext(await fetchStatic("/CAF%C3%89.txt"));
  });

  describe("HFS+ (realpath returns decomposed names)", () => {
    beforeAll(() => {
      fixture.hfs = true;
    });
    afterAll(() => {
      fixture.hfs = false;
    });

    test("serves a composed request", async () => {
      await expectServed(await fetchStatic("/na%C3%AFve.txt"), "NFC_NAME");
      await expectServed(await fetchStatic("/caf%C3%A9.txt"), "NFD_NAME");
    });

    test("still falls through for a differently cased spelling", async () => {
      await expectNext(await fetchStatic("/NA%C3%AFVE.txt"));
      await expectNext(await fetchStatic("/ADMIN/x.txt"));
    });
  });

  test("does not check the case of a name the middleware appended", async () => {
    await expectServed(await fetchStatic("/"), "<h1>root index</h1>");
    await expectServed(await fetchStatic("/docs/"), "<h1>docs index</h1>");
    await expectServed(await fetchStatic("/docs"), "<h1>docs index</h1>");
    await expectServed(await fetchStatic("/page"), "<h1>page</h1>");
    const res = await fetchStatic(
      "/logo.js",
      { encodings: true },
      { headers: { "accept-encoding": "br" } },
    );
    expect(res.headers.get("content-encoding")).toBe("br");
    await expectServed(res, "BROTLI_LOGO");
  });

  test("still checks the part of such a name that came from the URL", async () => {
    await expectNext(await fetchStatic("/DOCS/"));
    await expectNext(await fetchStatic("/Page"));
    // The URL named the extension here, so it is the URL's to match.
    await expectNext(await fetchStatic("/page.html"));
    await expectServed(await fetchStatic("/page.HTML"), "<h1>page</h1>");
  });

  test("falls through for a differently cased precompressed variant", async () => {
    const accept = { headers: { "accept-encoding": "br" } };
    await expectNext(await fetchStatic("/APP.JS", { encodings: true }, accept));
    // Only the variant is miscased here: the identity file still serves.
    const res = await fetchStatic("/skew.js", { encodings: true }, accept);
    expect(res.headers.get("content-encoding")).toBeNull();
    await expectServed(res, "PLAIN_SKEW");
  });

  test("serves when only `dir` differs from the on-disk case", async () => {
    const upperDir = join(tmp, "PUBLIC");
    await expectServed(await fetchStatic("/admin/x.txt", { dir: upperDir }), "ADMIN_X");
    await expectNext(await fetchStatic("/ADMIN/x.txt", { dir: upperDir }));
  });

  test("serves in-root symlinks at their own case", async () => {
    await expectServed(await fetchStatic("/link.txt"), "ADMIN_X");
    await expectServed(await fetchStatic("/admin-link/x.txt"), "ADMIN_X");
  });

  test("still refuses escaping and dot-path links under another case", async () => {
    await expectNext(await fetchStatic("/ESCAPE.txt"));
    await expectNext(await fetchStatic("/ENV-ALIAS.txt"));
  });

  // Documented gap: once a symlink is followed, the resolved path no longer
  // mirrors the request, so a case-only difference cannot be told apart from
  // the link's own renaming.
  test("known gap: a differently cased spelling through an in-root symlink serves", async () => {
    await expectServed(await fetchStatic("/LINK.txt"), "ADMIN_X");
    await expectServed(await fetchStatic("/admin-link/X.TXT"), "ADMIN_X");
  });
});

describe("isSpellingAlias", () => {
  test.each([
    // [real, lex, suffixLength, sep, alias]
    ["admin/x.txt", "admin/x.txt", 0, "/", false],
    ["admin/x.txt", "ADMIN/x.txt", 0, "/", true],
    ["admin/x.txt", "admin/X.TXT", 0, "/", true],
    ["sub/inside.txt", "link.txt", 0, "/", false], // a followed symlink
    ["cafe\u0301.txt", "caf\u00e9.txt", 0, "/", false], // normalization only
    ["cafe\u0301.txt", "CAF\u00c9.txt", 0, "/", true],
    ["Index.html", "index.html", 10, "/", false], // appended by the middleware
    ["docs/INDEX.HTML", "docs/index.html", 11, "/", false],
    ["Docs/index.html", "docs/index.html", 11, "/", true],
    ["page.HTML", "page.html", 5, "/", false],
    ["Page.html", "page.html", 5, "/", true],
    ["other.txt", "page.html", 5, "/", false], // suffix renamed by a symlink
    ["cafe\u0301.txt", "cafe\u0301.txt", 0, "/", false], // decomposed, exact
    ["caf\u00e9.txt", "cafe\u0301.txt", 0, "/", true], // decomposed request, composed disk
    ["Key/x.txt", "\u212Aey/x.txt", 0, "/", true], // KELVIN SIGN, which NFC maps to K
    // Windows
    ["admin\\x.txt", "admin\\x.txt", 0, "\\", false],
    ["admin\\x.txt", "ADMIN\\X.txt", 0, "\\", true],
    ["administrator\\x.txt", "ADMINI~1\\x.txt", 0, "\\", true],
    ["docs\\long-file-name.txt", "docs\\LONGFI~1.TXT", 0, "\\", true],
    ["docs\\long-file-name.txt", "docs\\longfi~12.txt", 0, "\\", true],
    ["Docs\\index.html", "docs\\Index.html", 11, "\\", true],
    ["sub\\x.txt", "link~1\\x.txt", 0, "\\", true], // a link shaped like one
    ["target.txt", "my-backup~2", 0, "\\", false], // base too long
    ["target.txt", "a.b~1.txt", 0, "\\", false], // dot in the base
    ["vendor.html", "VENDOR~1.HTM", 0, "\\", true],
    ["target.txt", "v~1.json", 0, "\\", false], // extension too long
    ["target.txt", "v~1.txt", 0, "/", false], // POSIX has no short names
  ] as const)("%j vs %j (suffix %d, sep %j) -> %s", (real, lex, suffixLength, sep, alias) => {
    expect(isSpellingAlias(real, lex, suffixLength, sep)).toBe(alias);
  });
});

describe("departingPrefix", () => {
  test.each([
    // [real, lex, sep, prefix]
    ["admin/x.txt", "ADMIN/x.txt", "/", "ADMIN"],
    ["admin/x.txt", "admin/X.txt", "/", "admin/X.txt"],
    ["sub/inside.txt", "SUB/inside.txt", "/", "SUB"],
    ["sub/x.txt", "v~1.txt", "/", "v~1.txt"],
    ["admin/x.txt", "admin/x.txt", "/", undefined],
    ["administrator\\x.txt", "ADMINI~1\\x.txt", "\\", "ADMINI~1"],
    ["docs\\readme.md", "docs\\README.md", "\\", "docs\\README.md"],
  ] as const)("%j vs %j (sep %j) -> %j", (real, lex, sep, prefix) => {
    expect(departingPrefix(real, lex, sep)).toBe(prefix);
  });
});
