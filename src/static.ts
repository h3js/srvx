import type { ServerMiddleware } from "./types.ts";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Transform } from "node:stream";

import { extname, join, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";
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
   * Serve precompressed variants from disk. Off by default: most deployments ship none,
   * so probing for one is a `stat` that always misses, on every compressible request.
   *
   * `true` uses `{ br: ".br", gzip: ".gz" }`; a map sets the extension per encoding (keys
   * tried in order, so list the preferred encoding first). For `/app.js` with
   * `Accept-Encoding: br`, `app.js.br` is served if it exists. A variant always wins over
   * on-the-fly `compress`, as it costs no CPU. `false` (the default) skips the lookup.
   *
   * @default false
   */
  encodings?: boolean | Record<string, string>;

  /**
   * Compress a response on the fly when no precompressed variant is served.
   *
   * Applies to compressible types only, and only to files between 1 KiB and 10 MiB —
   * precompress anything larger. Pass `false` to serve only what is already on disk (with
   * `encodings` off too, nothing is ever compressed).
   *
   * @default true
   */
  compress?: boolean;

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

// RFC 8615 reserves `/.well-known/` for public metadata (ACME HTTP-01
// challenges, `security.txt`), so it is the only dot segment served by default.
const DEFAULT_DOTFILES = [".well-known"];

const DEFAULT_ENCODINGS: Record<string, string> = { br: ".br", gzip: ".gz" };

// `createBrotliCompress()` defaults to BROTLI_DEFAULT_QUALITY (11), the maximum,
// which costs roughly 12x quality 4 for a few percent of size — per request, with
// nothing cached. Quality 4 is what CDNs encode at dynamically. The bill is not
// only this request's latency: zlib streams run on the same 4-thread libuv pool
// as every `stat`/`open` here, so an over-tuned quality stalls the fs work too.
const BROTLI_QUALITY = 4;

// Under a TCP segment there is nothing to win: the encoded body can come out
// larger than the input, and it costs a round of CPU to find that out.
const COMPRESS_MIN_SIZE = 1024;

// Compression inverts what normally makes a large file self-limiting — the
// response gets *smaller* while the server burns CPU proportional to the
// *uncompressed* size, so the request stops paying for itself in bandwidth.
// Past this, serve the bytes as-is and let a build step precompress them.
const COMPRESS_MAX_SIZE = 10 * 1024 * 1024;

const COMPRESSORS: Record<string, (sizeHint: number) => Transform> = {
  br: (sizeHint) =>
    createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        // Known here and never a guess, so brotli can size its window and
        // allocations up front rather than growing them as the stream runs.
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: sizeHint,
      },
    }),
  // zlib's own default level (6). gzip is cheap enough at any level — roughly an
  // order of magnitude under brotli — that the default needs no walking back.
  gzip: () => createGzip(),
};

// Append `sep` so prefix checks only match at a segment boundary (`/srv/www`
// must not also match `/srv/www-backup`). Roots already end with `sep`.
const asPrefix = (path: string): string => (path.endsWith(sep) ? path : path + sep);

// A candidate is only known to be a regular file once it is open (the check is an
// `fstat` on the fd), and `open()` on a FIFO blocks until a writer arrives. Without
// `O_NONBLOCK` a pipe swapped in for a file — before the `stat` that precedes an
// `open`, or between the two — parks a libuv threadpool thread indefinitely, and the
// pool is 4 threads by default, so a handful of requests stall every fs op in the
// process. Reads of regular files ignore the flag. Windows has no `O_NONBLOCK` and
// cannot block this way: the `?? 0` leaves plain `O_RDONLY` there.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

type ServableFile = { handle: FileHandle; size: number };

// An encoding this middleware can answer with: by serving a precompressed variant
// beside the file (`ext`), by encoding on the fly (`compressor`), or either.
type EncodingSpec = {
  name: string;
  ext?: string;
  compressor?: (sizeHint: number) => Transform;
};

export const serveStatic = (options: ServeStaticOptions): ServerMiddleware => {
  // `resolve()` also converts separators (`C:/assets` -> `C:\assets`), and
  // `join()`/`realpath()` only emit native ones, so every path a `sep`-based
  // check sees is already in platform form.
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

  const encodings = options.encodings === true ? DEFAULT_ENCODINGS : options.encodings || {};
  const compress = options.compress ?? true;

  // Encodings served, in server-preference order. Disk variants lead: their order
  // is the documented preference, and a variant costs no CPU. An encoding reachable
  // only by compressing follows, so the default (no `encodings`, `compress` on) is
  // "never probe the disk, always encode on the fly" rather than a dead option.
  const served: EncodingSpec[] = [
    ...Object.entries(encodings).map(([name, ext]) => ({
      name,
      ext,
      compressor: compress ? COMPRESSORS[name] : undefined,
    })),
    ...(compress
      ? Object.keys(COMPRESSORS)
          .filter((name) => !(name in encodings))
          .map((name) => ({ name, compressor: COMPRESSORS[name] }))
      : []),
  ];
  const varyOnEncoding = served.length > 0;

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

  // The real security boundary, and the only way a served file is opened. The
  // handler's checks are lexical while the filesystem follows symlinks, so a
  // link inside `dir` could escape the root (`escape.txt` -> `/etc/passwd`) or
  // alias a denied dot path to an allowed name (`public.txt` -> `.env`): both
  // invariants are re-asserted against the resolved path. Links that stay
  // inside `dir` on an allowed path still work.
  //
  // The bytes served come from the fd opened here, and the final inode
  // comparison pins that fd to the path that passed the checks — with a
  // check-then-`createReadStream(path)` sequence, a symlink swap in between
  // would serve a file the checks never saw.
  const openServable = async (candidate: string): Promise<ServableFile | null> => {
    const handle = await open(candidate, OPEN_FLAGS).catch(() => null);
    if (handle === null) {
      return null;
    }
    try {
      const fileStat = await handle.stat();
      const realPath = fileStat.isFile() ? await realpath(candidate).catch(() => null) : null;
      if (realPath !== null) {
        const root = await getRealDir();
        if (realPath.startsWith(root) && !isDeniedDotPath(realPath.slice(root.length))) {
          const realStat = await stat(realPath).catch(() => null);
          if (realStat && realStat.ino === fileStat.ino && realStat.dev === fileStat.dev) {
            return { handle, size: fileStat.size };
          }
        }
      }
    } catch {
      // fall through to close
    }
    await handle.close().catch(() => {});
    return null;
  };

  return async (req, next) => {
    if (!methods.has(req.method)) {
      return next();
    }
    const url = (req._url ??= new FastURL(req.url));
    let path = url.pathname.slice(1);
    // `/sub/` names a directory, so only its index is probed: serving `sub.html`
    // or a file named `sub` there would mint a second URL for them, with
    // relative links inside resolving against the wrong base.
    const trailingSlash = path.endsWith("/");
    if (trailingSlash) {
      path = path.replace(/\/+$/, "");
    }
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
    } else if (trailingSlash) {
      paths = [`${path}/index.html`];
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
    let acceptEncodings: EncodingSpec[] | undefined;
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
      // Already-compressed types gain nothing from either path. `renderHTML`
      // routes are excluded too: a variant on disk would not match the rendered
      // output, and the rendered `Response` is the caller's to encode.
      const compressible = !renderHTML && isCompressible(contentType);

      let encoding = "";
      let servePath = filePath;
      let file: ServableFile | null = null;
      if (compressible) {
        acceptEncodings ??= parseAcceptEncoding(req.headers.get("accept-encoding"), served);
        for (const spec of acceptEncodings) {
          if (!spec.ext) {
            continue;
          }
          const variantPath = filePath + spec.ext;
          // `stat` before `open`: a missing variant (the common case) should cost
          // one syscall rather than an `open`/`fstat`/`close`.
          if (!(await statFile(variantPath))) {
            continue;
          }
          // An unservable variant (escapes the root, or resolves onto a denied
          // dot path) is skipped, not fatal: the identity file can still serve.
          const variant = await openServable(variantPath);
          if (variant) {
            encoding = spec.name;
            servePath = variantPath;
            file = variant;
            break;
          }
        }
      }
      // Only the bytes actually sent need checking; a winning variant already was.
      file ??= await openServable(filePath);
      if (!file) {
        continue;
      }
      // Nothing precompressed on disk: encode on the fly instead, provided the
      // client takes an encoding we can produce and the file is in the size band
      // where spending CPU is worth it. `file.size` (an `fstat` on the fd we are
      // about to read) is the size actually served, not the earlier probe's.
      let compressor: ((sizeHint: number) => Transform) | undefined;
      if (
        compressible &&
        !encoding &&
        file.size >= COMPRESS_MIN_SIZE &&
        file.size <= COMPRESS_MAX_SIZE
      ) {
        const spec = acceptEncodings!.find((s) => s.compressor);
        if (spec) {
          encoding = spec.name;
          compressor = spec.compressor;
        }
      }
      if (renderHTML) {
        let html: string;
        try {
          html = await file.handle.readFile("utf8");
        } finally {
          await file.handle.close().catch(() => {});
        }
        const rendered = await renderHTML({
          html,
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
        "Content-Type": contentType.startsWith("text/")
          ? `${contentType}; charset=utf-8`
          : contentType,
      };
      // An encoded length is only known once the bytes exist, so an on-the-fly
      // response is chunked. A variant's length is just its size on disk.
      if (!compressor) {
        headers["Content-Length"] = file.size.toString();
      }
      if (encoding) {
        headers["Content-Encoding"] = encoding;
      }
      if (varyOnEncoding && compressible) {
        // Also set on the identity response: shared caches must key on the
        // header either way.
        headers["Vary"] = "Accept-Encoding";
      }
      if (req.method === "HEAD") {
        // Node discards a HEAD body at the http layer, so skip the read — and
        // with it the compression a GET would pay for. The headers still
        // describe what GET would send, chunked encoding included.
        await file.handle.close().catch(() => {});
        return new FastResponse(null, { headers });
      }
      // The stream closes the handle when it ends or errors (`autoClose`).
      const stream = file.handle.createReadStream();
      if (!compressor) {
        return new FastResponse(stream as any, { headers });
      }
      // `pipeline` rather than `stream.pipe(encoded)`: `pipe` leaves the source
      // running if the destination errors or is destroyed, so a client that
      // disconnects mid-response would strand the fd until GC. `pipeline` tears
      // down both. Errors land in the callback (an aborted response is routine)
      // and destroy the streams, which surfaces to the client as a truncated
      // body — the response headers are long gone by then.
      const encoded = compressor(file.size);
      pipeline(stream, encoded, () => {});
      return new FastResponse(encoded as any, { headers });
    }
    return next();
  };
};

// --- internal ---

// Types that benefit from compression — everything else (images, video, audio,
// archives, fonts) is already compressed and would not have a `.br`/`.gz` variant.
function isCompressible(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/wasm"
  );
}

/**
 * Encodings from `served` the client accepts, in server-preference order.
 * `q=0` is honored as "not acceptable"; `*` applies to encodings not named explicitly.
 */
function parseAcceptEncoding(header: string | null, served: EncodingSpec[]): EncodingSpec[] {
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
  return served.filter(({ name }) => (quality.get(name) ?? wildcard ?? 0) > 0);
}
