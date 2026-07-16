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
   * Serve dotfiles (paths with a segment starting with `.`, such as `.env` or `.git/config`).
   *
   * @default false
   */
  dotfiles?: boolean;

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

// A path segment starting with `.` marks a dotfile. `.`/`..` segments never
// reach this check: `join()` resolves them before the path is tested, so
// `/sub/../index.html` is `index.html` here, not a dot segment.
const isDotPath = (relPath: string): boolean => relPath.split(sep).some((s) => s[0] === ".");

// The uncompressed file, always tried last so it acts as the fallback.
const IDENTITY: [encoding: string, ext: string] = ["", ""];

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
  const dotfiles = options.dotfiles === true;
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

  // Stat a candidate, rejecting anything that is not a regular file or whose
  // resolved path escapes `dir` (see `getRealDir`).
  const resolveFile = async (candidate: string): Promise<Stats | null> => {
    const fileStat = await stat(candidate).catch(() => null);
    if (!fileStat?.isFile()) {
      return null;
    }
    // The `startsWith(dir)` check on the caller side is lexical and cannot see
    // through symlinks, while `stat()` follows them: a link inside `dir` can
    // resolve to any file on the host. Re-assert containment against the
    // resolved path, which also covers links in intermediate segments. Links
    // staying inside `dir` are still served.
    const realPath = await realpath(candidate).catch(() => null);
    if (!realPath || !realPath.startsWith(await getRealDir())) {
      return null;
    }
    return fileStat;
  };

  return async (req, next) => {
    if (!methods.has(req.method)) {
      return next();
    }
    const url = (req._url ??= new FastURL(req.url));
    const path = url.pathname.slice(1).replace(/\/$/, "");
    let paths: string[];
    if (path === "") {
      paths = ["index.html"];
    } else if (extname(path) === "") {
      // Probe the literal path before the `.html` route candidates, so an
      // extension-less file is reachable at its exact name: ACME challenge
      // tokens (`/.well-known/acme-challenge/<token>`), `LICENSE`,
      // `apple-app-site-association`. This also covers dotfiles, which land
      // here because `extname()` reports no extension for a leading-dot name
      // (`.env`) and would otherwise only be looked up as `.env.html`.
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
      if (!filePath.startsWith(dir)) {
        continue;
      }
      if (!dotfiles && isDotPath(filePath.slice(dir.length))) {
        continue;
      }
      const fileExt = extname(filePath);
      const contentType = COMMON_MIME_TYPES[fileExt] || "application/octet-stream";
      const renderHTML = fileExt === ".html" ? options.renderHTML : undefined;
      // Look for precompressed variants only where one could plausibly exist:
      // not for already-compressed types, and not for `renderHTML` routes,
      // whose output a variant on disk would not match.
      const compressible = !renderHTML && isCompressible(contentType);
      for (const [encoding, ext] of compressible ? [...acceptEncodings, IDENTITY] : [IDENTITY]) {
        const servePath = filePath + ext;
        const fileStat = await resolveFile(servePath);
        if (!fileStat) {
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
    }
    return next();
  };
};
