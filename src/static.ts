import type { ServerMiddleware } from "./types.ts";
import type { Stats } from "node:fs";

import { extname, join, resolve, sep } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { FastResponse } from "srvx";
import { FastURL } from "./_url.ts";

export interface ServeStaticOptions {
  /**
   * The directory to serve static files from.
   */
  dir: string;

  /**
   * The HTTP methods to allow for serving static files.
   */
  methods?: string[];

  /**
   * Dot segments (a path segment starting with `.`, such as `.env` or `.git`) that may be served.
   *
   * An array allow-lists segments by exact name; a path containing any other dot segment falls
   * through to `next()`. `true` serves every dot segment, `false` (or `[]`) none.
   *
   * @default [".well-known"]
   */
  dotfiles?: boolean | string[];

  /**
   * Map of `Content-Encoding` to the file extension of its precompressed variant on disk.
   *
   * Files are never compressed on the fly: for `/app.js` with `Accept-Encoding: br`,
   * `app.js.br` is served if it exists, otherwise `app.js` is served as-is. Keys are
   * tried in order, so list the preferred encoding first. Pass `{}` to disable.
   *
   * @default { br: ".br", gzip: ".gz" }
   */
  encodings?: Record<string, string>;

  /**
   * A function to modify the HTML content before serving it.
   */
  renderHTML?: (ctx: {
    request: Request;
    html: string;
    filename: string;
  }) => Response | Promise<Response>;
}

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/MIME_types/Common_types
const COMMON_MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".gif": "image/gif",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
};

// Types that benefit from compression. Everything else (images, video, audio,
// archives, fonts) is already compressed, so a `.br`/`.gz` variant would not
// exist and looking for one only costs stat calls.
const isCompressible = (mimeType: string): boolean =>
  mimeType.startsWith("text/") ||
  mimeType.endsWith("+json") ||
  mimeType.endsWith("+xml") ||
  mimeType === "application/json" ||
  mimeType === "application/xml" ||
  mimeType === "application/javascript" ||
  mimeType === "application/wasm";

// RFC 8615 reserves `/.well-known/` for public metadata, so it is served by
// default: ACME HTTP-01 challenges and `security.txt` live there, and gating
// them behind an all-or-nothing opt-in would mean publishing `.env`/`.git` to
// renew a certificate. Every other dot segment stays hidden.
const DEFAULT_DOTFILES = [".well-known"];

/**
 * Encodings from `encodings` the client accepts, in server-preference order.
 *
 * `q=0` means "not acceptable" and is honored, so `br;q=0, gzip` serves gzip rather than
 * brotli. A `*` applies to any encoding not named explicitly.
 */
const parseAcceptEncoding = (
  header: string,
  encodings: Record<string, string>,
): [encoding: string, ext: string][] => {
  if (!header) {
    return [];
  }
  const quality = new Map<string, number>();
  for (const part of header.split(",")) {
    const [token, ...params] = part.split(";");
    const name = token!.trim().toLowerCase();
    if (!name) {
      continue;
    }
    let q = 1;
    for (const param of params) {
      const trimmed = param.trim();
      if (trimmed.startsWith("q=")) {
        // A malformed q (`q=abc`) parses to NaN; treat it as refused.
        q = Number.parseFloat(trimmed.slice(2)) || 0;
      }
    }
    quality.set(name, q);
  }
  const wildcard = quality.get("*");
  return Object.entries(encodings).filter(([name]) => (quality.get(name) ?? wildcard ?? 0) > 0);
};

export const serveStatic = (options: ServeStaticOptions): ServerMiddleware => {
  const dir = resolve(options.dir) + sep;
  const methods = new Set((options.methods || ["GET", "HEAD"]).map((m) => m.toUpperCase()));
  // `?? DEFAULT_DOTFILES` and not `||`: an explicit `false` must stay `false`.
  const dotfiles = options.dotfiles ?? DEFAULT_DOTFILES;
  const allowAllDots = dotfiles === true;
  const allowedDots = new Set(Array.isArray(dotfiles) ? dotfiles : []);

  // Deny a path with a dot segment that is not allow-listed. Matching is by
  // exact segment, so allowing `.well-known` exposes neither a sibling that
  // merely shares its prefix (`.well-known-backup`) nor a dot segment nested
  // under it (`.well-known/.env`).
  //
  // `.`/`..` segments never reach this check: `join()` resolves them before the
  // path is tested, so `/sub/../index.html` is `index.html` here, not a dot
  // segment.
  const isDeniedDotPath = (relPath: string): boolean =>
    !allowAllDots && relPath.split(sep).some((s) => s[0] === "." && !allowedDots.has(s));

  const encodings = options.encodings || { br: ".br", gzip: ".gz" };
  const varyOnEncoding = Object.keys(encodings).length > 0;

  // Real (symlink-resolved) `dir`, used to re-assert containment below. `dir`
  // itself may legitimately be a symlink (`/var/www` -> `/data/www`), so both
  // sides of the comparison have to be resolved or every file would be
  // rejected. Resolved lazily and cached only on success, so a `dir` that is
  // created after the first request is still picked up.
  let realDir: string | undefined;
  const getRealDir = async (): Promise<string> => {
    if (realDir === undefined) {
      const resolved = await realpath(dir).catch(() => null);
      if (resolved === null) {
        return dir;
      }
      realDir = resolved + sep;
    }
    return realDir;
  };

  // Existence and type only. Containment costs a `realpath` (see `isContained`)
  // and is only worth paying for the candidate actually served.
  const statFile = async (candidate: string): Promise<Stats | null> => {
    const fileStat = await stat(candidate).catch(() => null);
    return fileStat?.isFile() ? fileStat : null;
  };

  // The containment boundary. `stat()` follows symlinks and the lexical
  // `startsWith(dir)` pre-filter cannot see through them, so a link inside
  // `dir` can resolve to any file on the host. Re-assert against the resolved
  // path, which also covers links in intermediate segments. Links staying
  // inside `dir` are still served.
  const isContained = async (candidate: string): Promise<boolean> => {
    const realPath = await realpath(candidate).catch(() => null);
    return realPath !== null && realPath.startsWith(await getRealDir());
  };

  return async (req, next) => {
    if (!methods.has(req.method)) {
      return next();
    }
    const url = (req._url ??= new FastURL(req.url));
    let path = url.pathname.slice(1).replace(/\/$/, "");
    if (path.includes("%")) {
      // `url.pathname` keeps the wire encoding, so decode exactly once here or
      // any name a client must encode (`hello world.txt`, `café.txt`) is
      // unreachable. `decodeURI`, not `decodeURIComponent`: it keeps `%2F`,
      // `%3F` and `%23` encoded, so an encoded separator never becomes a
      // separator.
      //
      // Nothing below relies on the pathname arriving normalized. `FastURL`
      // does resolve dot segments in practice (`_needsNormRE` in `_url.ts`
      // deopts `.`, `..` and their `%2e` forms to the native parser), but that
      // is an invariant of another module, and decoding can surface a dot
      // segment after it has already run (`%252e%252e` -> `%2e%2e`, `%5C` on
      // Windows). So containment rests only on `join()` + `startsWith(dir)`
      // below, which resolve and re-check whatever actually reaches them; the
      // "unresolved pathname" tests feed a raw `/../` straight in to pin that.
      try {
        path = decodeURI(path);
      } catch {
        // Malformed encoding (`/foo%`, `/%ZZ`): reject like nginx/serve-static
        // do rather than guessing at a lookup for a raw `%` name.
        return new FastResponse("Bad Request", { status: 400 });
      }
    }
    let paths: string[];
    if (path === "") {
      paths = ["index.html"];
    } else if (extname(path) === "") {
      // TODO: consider answering `/sub` with a 303 redirect to `/sub/` instead
      // of serving `sub/index.html` in place (nginx sends 301): without the
      // trailing slash, relative links inside that index resolve against `/`.
      // Probe the literal path before the `.html` route candidates, so an
      // extension-less file is reachable at its exact name: ACME challenge
      // tokens (`/.well-known/acme-challenge/<token>`), `LICENSE`,
      // `apple-app-site-association`. This also covers allow-listed dotfiles,
      // which land here because `extname()` reports no extension for a
      // leading-dot name (`.env`) and would otherwise only be looked up as
      // `.env.html`.
      paths = [path, `${path}.html`, `${path}/index.html`];
    } else {
      paths = [path];
    }
    const acceptEncodings = parseAcceptEncoding(
      req.headers.get("accept-encoding") || "",
      encodings,
    );
    for (const path of paths) {
      const filePath = join(dir, path);
      // A cheap pre-filter, not the containment boundary — `isContained` is.
      // This rejects an obvious escape without spending a syscall, and it is
      // what makes `slice(dir.length)` below an actual relative path.
      if (!filePath.startsWith(dir)) {
        continue;
      }
      if (isDeniedDotPath(filePath.slice(dir.length))) {
        continue;
      }
      // The identity file gates the candidate: a client that accepts no
      // encoding needs it regardless, so a variant without one beside it is
      // already a broken deploy. Probing it first costs one extra stat when a
      // variant then wins (2 -> 3 syscalls for `/app.js` + `br`), but keeps a
      // miss at one syscall per candidate rather than one per accepted encoding
      // (7 -> 3 for `/nope`). Misses are worth the trade: the middleware falls
      // through to the app on every unmatched route, so all non-static traffic
      // pays that path, as does anything probing for `.env`/`.git`.
      const identityStat = await statFile(filePath);
      if (!identityStat) {
        continue;
      }
      const fileExt = extname(filePath);
      const contentType = COMMON_MIME_TYPES[fileExt] || "application/octet-stream";
      const renderHTML = fileExt === ".html" ? options.renderHTML : undefined;
      // Look for precompressed variants only where one could plausibly exist:
      // not for already-compressed types, and not for `renderHTML` routes,
      // whose output a variant on disk would not match.
      const compressible = !renderHTML && isCompressible(contentType);

      let encoding = "";
      let servePath = filePath;
      let fileStat = identityStat;
      if (compressible) {
        for (const [name, ext] of acceptEncodings) {
          const variantPath = filePath + ext;
          const variantStat = await statFile(variantPath);
          // An escaping variant is skipped rather than fatal: the identity file
          // below still serves, provided it is itself contained.
          if (variantStat && (await isContained(variantPath))) {
            encoding = name;
            servePath = variantPath;
            fileStat = variantStat;
            break;
          }
        }
      }
      // Only the bytes actually sent need containing, and a variant that won
      // above is already checked.
      if (!encoding && !(await isContained(filePath))) {
        continue;
      }
      // `Content-Type` comes from the base path: the variant's own extension
      // is the encoding (`.br`), not the media type.
      const headers: Record<string, string> = {
        "Content-Length": fileStat.size.toString(),
        "Content-Type": contentType,
      };
      if (encoding) {
        headers["Content-Encoding"] = encoding;
      }
      if (varyOnEncoding && compressible) {
        // Set on the identity variant too, not just when an encoded one is
        // served: a shared cache must key on the header either way.
        headers["Vary"] = "Accept-Encoding";
      }
      if (renderHTML) {
        const rendered = await renderHTML({
          html: await readFile(servePath, "utf8"),
          filename: servePath,
          request: req,
        });
        if (req.method !== "HEAD") {
          return rendered;
        }
        // A HEAD response carries the same headers as GET, without the body.
        // Cancel the unused body so a stream-backed rendered response
        // releases its underlying resource instead of waiting for GC.
        await rendered.body?.cancel().catch(() => {});
        return new FastResponse(null, {
          status: rendered.status,
          statusText: rendered.statusText,
          headers: rendered.headers,
        });
      }
      if (req.method === "HEAD") {
        // Node discards a HEAD body at the http layer, so reading the file
        // would burn I/O for bytes that never reach the wire.
        return new FastResponse(null, { headers });
      }
      return new FastResponse(createReadStream(servePath) as any, { headers });
    }
    return next();
  };
};
