import type { ServerMiddleware } from "./types.ts";
import type { Transform } from "node:stream";

import { extname, join, resolve, sep } from "node:path";
import { readFile, stat, realpath } from "node:fs/promises";
import { createReadStream, ReadStream } from "node:fs";
import { FastResponse } from "srvx";
import { createGzip, createBrotliCompress } from "node:zlib";
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
   * Value for the `Cache-Control` response header.
   *
   * Defaults to a conservative `"public, max-age=0, must-revalidate"` which
   * lets clients cache but forces revalidation (via `ETag`/`Last-Modified`)
   * on every request. Set to `false` to omit the header entirely.
   */
  cacheControl?: string | false;

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
  ".br": "application/x-brotli",
  ".pdf": "application/pdf",
};

/**
 * Whether a MIME type benefits from compression. Already-compressed binary
 * formats (images, video, audio, archives, fonts) are excluded so we never
 * waste CPU re-encoding them.
 */
function isCompressible(mimeType: string): boolean {
  const type = mimeType.split(";", 1)[0].trim();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/wasm" ||
    type === "image/svg+xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/**
 * Parse an `Accept-Encoding` header into a `token -> q-value` map, honoring
 * q-values (so `br;q=0` disables brotli) and only matching exact tokens (so a
 * value like `abbr` never matches `br`).
 */
function parseAcceptEncoding(header: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().split(";");
    const name = token.trim().toLowerCase();
    if (!name) {
      continue;
    }
    let q = 1;
    for (const param of params) {
      const match = /^q=(\d+(?:\.\d+)?)$/.exec(param.trim());
      if (match) {
        q = Number.parseFloat(match[1]);
      }
    }
    map.set(name, q);
  }
  return map;
}

/**
 * Negotiate a content encoding from an `Accept-Encoding` header, preferring
 * brotli, then gzip, and falling back to identity (`undefined`) when neither is
 * acceptable (q=0 / absent).
 */
function negotiateEncoding(header: string): "br" | "gzip" | undefined {
  if (!header) {
    return undefined;
  }
  const map = parseAcceptEncoding(header);
  const star = map.get("*");
  const qOf = (name: string): number => {
    const direct = map.get(name);
    if (direct !== undefined) {
      return direct;
    }
    return star ?? 0;
  };
  const brQ = qOf("br");
  const gzipQ = qOf("gzip");
  if (brQ > 0 && brQ >= gzipQ) {
    return "br";
  }
  if (gzipQ > 0) {
    return "gzip";
  }
  return undefined;
}

/** Weak `ETag` comparison (RFC 9110): ignore any leading `W/`. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  const normalize = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return ifNoneMatch.split(",").some((tag) => normalize(tag) === target);
}

export const serveStatic = (options: ServeStaticOptions): ServerMiddleware => {
  const dir = resolve(options.dir) + sep;
  const methods = new Set((options.methods || ["GET", "HEAD"]).map((m) => m.toUpperCase()));
  const cacheControl =
    options.cacheControl === undefined
      ? "public, max-age=0, must-revalidate"
      : options.cacheControl;

  // Real (symlink-resolved) base directory, resolved lazily and cached. Used to
  // reject files that escape `dir` through a symlink.
  let realDir: string | undefined;

  return async (req, next) => {
    if (!methods.has(req.method)) {
      return next();
    }
    const isHead = req.method === "HEAD";
    const url = (req._url ??= new FastURL(req.url));

    // Percent-decode the pathname so on-disk names with spaces/unicode are
    // reachable. Malformed sequences must not crash; fall through to `next()`.
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(1).replace(/\/$/, ""));
    } catch {
      return next();
    }

    // Deny any path segment starting with a dot. This is a deliberate denylist
    // that blocks dotfiles (`.env`, `.env.local`, `.npmrc.bak`, `.git/...`) and
    // dot-segment traversal (`.` / `..`, including once-encoded `%2e` forms
    // which are now decoded), so secrets and parent dirs are never served.
    //
    // A leading `.well-known` (RFC 8615) is the single exemption: it is a
    // registered, public-by-design namespace (ACME challenges, `security.txt`,
    // `assetlinks.json`) that must stay reachable. Only the first segment is
    // exempt, so everything below it is still denied (`/.well-known/.env`), and
    // `.well-known` nested anywhere else (`/sub/.well-known/...`) is not
    // well-known at all and stays denied too.
    const segments = path.split("/");
    const isWellKnown = segments[0] === ".well-known";
    for (let i = isWellKnown ? 1 : 0; i < segments.length; i++) {
      if (segments[i].startsWith(".")) {
        return next();
      }
    }

    let paths: string[];
    if (path === "") {
      paths = ["index.html"];
    } else if (isWellKnown || extname(path) !== "") {
      // Well-known URIs are exact identifiers, so the `.html`/`index.html`
      // fallback must not apply below `/.well-known/`: ACME challenge tokens
      // (`/.well-known/acme-challenge/<token>`) are extensionless and would
      // otherwise resolve to `<token>.html` and 404, silently breaking cert
      // renewal.
      paths = [path];
    } else {
      paths = [`${path}.html`, `${path}/index.html`];
    }

    for (const candidate of paths) {
      const filePath = join(dir, candidate);
      // Defense-in-depth: `join` normalization must not escape `dir`.
      if (!filePath.startsWith(dir)) {
        continue;
      }
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) {
        continue;
      }

      // Symlink escape: resolve the real path and ensure it stays inside the
      // real base directory before serving.
      try {
        if (realDir === undefined) {
          realDir = (await realpath(resolve(options.dir))) + sep;
        }
        const realFile = await realpath(filePath);
        if (realFile !== realDir.slice(0, -1) && !realFile.startsWith(realDir)) {
          continue;
        }
      } catch {
        continue;
      }

      const fileExt = extname(filePath);
      const contentType = COMMON_MIME_TYPES[fileExt] || "application/octet-stream";

      if (options.renderHTML && fileExt === ".html") {
        return options.renderHTML({
          html: await readFile(filePath, "utf8"),
          filename: filePath,
          request: req,
        });
      }

      // Validators for conditional requests and caching.
      const mtime = fileStat.mtime;
      const etag = `W/"${fileStat.size.toString(16)}-${mtime.getTime().toString(16)}"`;
      const lastModified = mtime.toUTCString();

      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": fileStat.size.toString(),
        ETag: etag,
        "Last-Modified": lastModified,
      };
      if (cacheControl) {
        headers["Cache-Control"] = cacheControl;
      }

      // Compression negotiation (only for compressible types). `Vary` is set on
      // both the compressed and the identity variant so caches key correctly.
      let encoding: "br" | "gzip" | undefined;
      if (isCompressible(contentType)) {
        headers["Vary"] = "Accept-Encoding";
        encoding = negotiateEncoding(req.headers.get("accept-encoding") || "");
        if (encoding) {
          headers["Content-Encoding"] = encoding;
          // Compressed length is unknown ahead of time.
          delete headers["Content-Length"];
        }
      }

      // Conditional requests: `If-None-Match` takes precedence over
      // `If-Modified-Since` (RFC 9110). Respond `304` with no body.
      const ifNoneMatch = req.headers.get("if-none-match");
      const ifModifiedSince = req.headers.get("if-modified-since");
      let notModified = false;
      if (ifNoneMatch) {
        notModified = etagMatches(ifNoneMatch, etag);
      } else if (ifModifiedSince) {
        const since = Date.parse(ifModifiedSince);
        // Compare at second resolution (HTTP dates have no sub-second part).
        if (!Number.isNaN(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since) {
          notModified = true;
        }
      }
      if (notModified) {
        delete headers["Content-Length"];
        delete headers["Content-Encoding"];
        return new FastResponse(null, { status: 304, headers });
      }

      // HEAD: send the same headers a GET would, with no body work.
      if (isHead) {
        return new FastResponse(null, { headers });
      }

      let stream: ReadStream | Transform = createReadStream(filePath);
      if (encoding === "br") {
        stream = stream.pipe(createBrotliCompress());
      } else if (encoding === "gzip") {
        stream = stream.pipe(createGzip());
      }
      return new FastResponse(stream as any, { headers });
    }
    return next();
  };
};
