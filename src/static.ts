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

// Types that benefit from compression — everything else (images, video, audio,
// archives, fonts) is already compressed and would not have a `.br`/`.gz` variant.
const isCompressible = (mimeType: string): boolean =>
  mimeType.startsWith("text/") ||
  mimeType.endsWith("+json") ||
  mimeType.endsWith("+xml") ||
  mimeType === "application/json" ||
  mimeType === "application/xml" ||
  mimeType === "application/wasm";

// RFC 8615 reserves `/.well-known/` for public metadata (ACME HTTP-01
// challenges, `security.txt`), so it is the only dot segment served by default.
const DEFAULT_DOTFILES = [".well-known"];

/**
 * Encodings from `encodings` the client accepts, in server-preference order.
 * `q=0` is honored as "not acceptable"; `*` applies to encodings not named explicitly.
 */
const parseAcceptEncoding = (
  header: string | null,
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
        // A malformed q (`q=abc`) parses to NaN: treat it as refused.
        q = Number.parseFloat(trimmed.slice(2)) || 0;
      }
    }
    quality.set(name, q);
  }
  const wildcard = quality.get("*");
  return Object.entries(encodings).filter(([name]) => (quality.get(name) ?? wildcard ?? 0) > 0);
};

// Append `sep` so prefix checks only match at a segment boundary (`/srv/www`
// must not also match `/srv/www-backup`). Roots already end with `sep`.
const asPrefix = (path: string): string => (path.endsWith(sep) ? path : path + sep);

export const serveStatic = (options: ServeStaticOptions): ServerMiddleware => {
  const dir = asPrefix(resolve(options.dir));
  const methods = new Set((options.methods || ["GET", "HEAD"]).map((m) => m.toUpperCase()));
  const dotfiles = options.dotfiles ?? DEFAULT_DOTFILES;
  const allowAllDots = dotfiles === true;
  const allowedDots = new Set(Array.isArray(dotfiles) ? dotfiles : []);

  // Deny paths with a non-allow-listed dot segment. Matching is by exact
  // segment, so allowing `.well-known` exposes neither `.well-known-backup`
  // nor `.well-known/.env`. (`.`/`..` never reach this check: `join()`
  // resolves them first.)
  const isDeniedDotPath = (relPath: string): boolean =>
    !allowAllDots && relPath.split(sep).some((s) => s[0] === "." && !allowedDots.has(s));

  const encodings = options.encodings || { br: ".br", gzip: ".gz" };
  const varyOnEncoding = Object.keys(encodings).length > 0;

  // Symlink-resolved `dir` for containment checks — `dir` itself may
  // legitimately be a symlink. Resolved lazily and cached only on success, so
  // a `dir` created after the first request is still picked up.
  let realDir: string | undefined;
  const getRealDir = async (): Promise<string> => {
    if (realDir === undefined) {
      const resolved = await realpath(dir).catch(() => null);
      if (resolved === null) {
        return dir;
      }
      realDir = asPrefix(resolved);
    }
    return realDir;
  };

  const statFile = async (candidate: string): Promise<Stats | null> => {
    const fileStat = await stat(candidate).catch(() => null);
    return fileStat?.isFile() ? fileStat : null;
  };

  // The real security boundary. The handler's checks are lexical while
  // `stat()` follows symlinks, so a link inside `dir` could escape the root
  // (`escape.txt` -> `/etc/passwd`) or alias a denied dot path to an allowed
  // name (`public.txt` -> `.env`). Re-assert both invariants against the
  // resolved path; links that stay inside `dir` on an allowed path still work.
  const isServable = async (candidate: string): Promise<boolean> => {
    const realPath = await realpath(candidate).catch(() => null);
    if (realPath === null) {
      return false;
    }
    const root = await getRealDir();
    return realPath.startsWith(root) && !isDeniedDotPath(realPath.slice(root.length));
  };

  return async (req, next) => {
    if (!methods.has(req.method)) {
      return next();
    }
    const url = (req._url ??= new FastURL(req.url));
    let path = url.pathname.slice(1).replace(/\/$/, "");
    if (path.includes("%")) {
      // Decode the wire encoding exactly once, or names a client must encode
      // (`café.txt`) are unreachable. `decodeURI` (not `decodeURIComponent`)
      // keeps `%2F`/`%3F`/`%23` encoded, so an encoded separator never becomes
      // a separator. Containment does not rely on the pathname arriving
      // normalized: `join()` + `startsWith(dir)` below re-check whatever
      // reaches them, including dot segments that decoding surfaces.
      try {
        path = decodeURI(path);
      } catch {
        // Malformed encoding (`/foo%`, `/%ZZ`): reject like nginx/serve-static.
        return new FastResponse("Bad Request", { status: 400 });
      }
    }
    let paths: string[];
    if (path === "") {
      paths = ["index.html"];
    } else if (extname(path) === "") {
      // TODO: consider answering `/sub` with a redirect to `/sub/` instead of
      // serving `sub/index.html` in place (nginx sends 301): without the
      // trailing slash, relative links inside that index resolve against `/`.
      //
      // The literal path comes first so an extension-less file is reachable at
      // its exact name: ACME challenge tokens, `LICENSE`, and allow-listed
      // dotfiles like `.env` (which `extname()` reports as extension-less).
      paths = [path, `${path}.html`, `${path}/index.html`];
    } else {
      paths = [path];
    }
    // Parsed lazily: unmatched routes (all non-static traffic) never need it.
    let acceptEncodings: [encoding: string, ext: string][] | undefined;
    for (const candidate of paths) {
      const filePath = join(dir, candidate);
      // Cheap lexical pre-filter — `isServable` is the real boundary. Also
      // guarantees `slice(dir.length)` yields an actual relative path.
      if (!filePath.startsWith(dir) || isDeniedDotPath(filePath.slice(dir.length))) {
        continue;
      }
      // The identity file gates the candidate: a variant without one beside it
      // is a broken deploy, and probing it first keeps a miss (all unmatched
      // traffic) at one syscall per candidate instead of one per encoding.
      const identityStat = await statFile(filePath);
      if (!identityStat) {
        continue;
      }
      const contentType = COMMON_MIME_TYPES[extname(filePath)] || "application/octet-stream";
      // Keyed off the resolved type so `.htm` renders like `.html`.
      const renderHTML = contentType === "text/html" ? options.renderHTML : undefined;
      // No variant lookup for already-compressed types, nor for `renderHTML`
      // routes, whose output a variant on disk would not match.
      const compressible = !renderHTML && isCompressible(contentType);

      let encoding = "";
      let servePath = filePath;
      let fileStat = identityStat;
      if (compressible) {
        acceptEncodings ??= parseAcceptEncoding(req.headers.get("accept-encoding"), encodings);
        for (const [name, ext] of acceptEncodings) {
          const variantPath = filePath + ext;
          const variantStat = await statFile(variantPath);
          // An unservable variant (escapes the root, or resolves onto a denied
          // dot path) is skipped, not fatal: the identity file can still serve.
          if (variantStat && (await isServable(variantPath))) {
            encoding = name;
            servePath = variantPath;
            fileStat = variantStat;
            break;
          }
        }
      }
      // Only the bytes actually sent need checking; a winning variant already was.
      if (!encoding && !(await isServable(filePath))) {
        continue;
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
        // HEAD carries GET's headers without the body; cancel the unused body
        // so a stream-backed rendered response releases its resource.
        await rendered.body?.cancel().catch(() => {});
        return new FastResponse(null, {
          status: rendered.status,
          statusText: rendered.statusText,
          headers: rendered.headers,
        });
      }
      // `Content-Type` comes from the base path: the variant's own extension
      // is the encoding (`.br`), not the media type. Text carries an explicit
      // charset so browsers do not decode non-ASCII with a guessed fallback.
      const headers: Record<string, string> = {
        "Content-Length": fileStat.size.toString(),
        "Content-Type": contentType.startsWith("text/")
          ? `${contentType}; charset=utf-8`
          : contentType,
      };
      if (encoding) {
        headers["Content-Encoding"] = encoding;
      }
      if (varyOnEncoding && compressible) {
        // Also set on the identity response: shared caches must key on the
        // header either way.
        headers["Vary"] = "Accept-Encoding";
      }
      if (req.method === "HEAD") {
        // Node discards a HEAD body at the http layer; skip the file I/O.
        return new FastResponse(null, { headers });
      }
      return new FastResponse(createReadStream(servePath) as any, { headers });
    }
    return next();
  };
};
