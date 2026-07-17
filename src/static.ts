import type { ServerMiddleware } from "./types.ts";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Transform } from "node:stream";

import { extname, join, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
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
   * Emit a `Last-Modified` header from the file's modification time, and answer an
   * `If-Modified-Since` conditional request that still matches with `304 Not Modified`.
   *
   * @default true
   */
  lastModified?: boolean;

  /**
   * Emit an `ETag` validator, and answer an `If-None-Match` conditional request that still
   * matches with `304 Not Modified`.
   *
   * The tag is weak (`W/"…"`): it is derived from the file's size and modification time
   * rather than its bytes, and folds in the `Content-Encoding`, so a brotli and a gzip
   * response under one URL never share one — which a cache keying on `Vary` relies on.
   *
   * @default true
   */
  etag?: boolean;

  /**
   * Freshness lifetime, in **seconds**, emitted as `Cache-Control: max-age=<n>`.
   *
   * Off by default: no `Cache-Control` header is sent, so a client revalidates
   * with the `ETag`/`Last-Modified` validators on every use. Set it to let a
   * client reuse a response without a request until it goes stale.
   *
   * @default undefined
   */
  maxAge?: number;

  /**
   * Add the `immutable` directive to `Cache-Control`, telling a client not to
   * revalidate a still-fresh response even on an explicit reload.
   *
   * Only takes effect alongside `maxAge`, and only makes sense for a
   * fingerprinted (content-hashed) asset, whose URL changes when its bytes do.
   *
   * @default false
   */
  immutable?: boolean;

  /**
   * Answer a single byte-range GET request with `206 Partial Content`, and
   * advertise `Accept-Ranges: bytes` on responses that could serve one.
   *
   * A range request is served the identity bytes only — content negotiation is
   * skipped — since a range over an on-the-fly (chunked) encoding is not
   * expressible, and range consumers (media seek, download resumption) target
   * already-compressed types. `false` disables it: no `206`/`416`, and the
   * header is never sent.
   *
   * @default true
   */
  ranges?: boolean;

  /**
   * Serve a minimal HTML directory listing when a request resolves to a
   * directory that has no index file (`index.html`). A directory that does have
   * one always serves the index instead.
   *
   * Entries are the directory's immediate children, with denied dot segments
   * (see `dotfiles`) hidden just as they are for file requests. Only names are
   * revealed, never file contents.
   *
   * Off by default — it exposes the directory structure, so it is opt-in. The
   * `srvx` CLI turns it on in dev mode only.
   *
   * @default false
   */
  dirListing?: boolean;

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

type ServableFile = { handle: FileHandle; size: number; mtimeMs: number };

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

  const lastModified = options.lastModified ?? true;
  const etag = options.etag ?? true;
  const ranges = options.ranges ?? true;
  const dirListing = options.dirListing ?? false;

  // Depends only on the options, so it is built once. Empty when `maxAge` is
  // unset — the header is fully opt-in.
  const cacheControl = buildCacheControl(options.maxAge, options.immutable);

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
            return { handle, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
          }
        }
      }
    } catch {
      // fall through to close
    }
    await handle.close().catch(() => {});
    return null;
  };

  // The immediate children of a directory safe to list, or null when the path is
  // not a listable directory. Re-asserts the same boundaries a file request gets:
  // lexical containment, then symlink-resolved containment (a link inside `dir`
  // could point the directory out of the root), and the dot-path deny check on
  // both the requested path and each entry — so a listing never names what a
  // direct request would refuse to serve.
  const readListing = async (relPath: string): Promise<{ name: string; dir: boolean }[] | null> => {
    const dirPath = relPath === "" ? dir : join(dir, relPath);
    if (
      relPath !== "" &&
      (!dirPath.startsWith(dir) || isDeniedDotPath(dirPath.slice(dir.length)))
    ) {
      return null;
    }
    const realPath = await realpath(dirPath).catch(() => null);
    if (realPath === null) {
      return null;
    }
    const root = await getRealDir();
    const realWithSep = asPrefix(realPath);
    if (!realWithSep.startsWith(root) || isDeniedDotPath(realWithSep.slice(root.length))) {
      return null;
    }
    // `withFileTypes` reads the type from the same `readdir` syscall, so the
    // trailing-slash decoration below costs no extra `stat` per entry. A
    // non-directory (or an unreadable one) throws and falls through to `null`.
    const dirents = await readdir(realPath, { withFileTypes: true }).catch(() => null);
    if (dirents === null) {
      return null;
    }
    const entries = dirents
      .filter((d) => !isDeniedDotPath(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }));
    // Directories first, then by name — a conventional, stable listing order.
    entries.sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1));
    return entries;
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
    // The `Range` header when this is a range request, `""` otherwise. A range
    // request bypasses negotiation entirely (identity bytes only): a range over
    // a chunked on-the-fly encoding is not expressible, and range consumers —
    // media seek, download resumption — target already-compressed types. GET
    // only, as RFC 9110 defines range handling for GET alone, so HEAD (and any
    // other configured method) ignores the header. Only a `bytes=` unit is a
    // range request; an unknown unit is treated as if no header were sent and
    // leaves negotiation untouched.
    let rangeRequest: string | undefined;
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
      // Resolved lazily, like `acceptEncodings`: the Node adapter materializes
      // its headers wrapper on the first `.get()`, and pure-miss traffic (every
      // non-static route falling through to `next()`) touches no header at all.
      if (rangeRequest === undefined) {
        const header = ranges && req.method === "GET" ? req.headers.get("range") : null;
        rangeRequest = header !== null && header.startsWith("bytes=") ? header : "";
      }

      let encoding = "";
      let servePath = filePath;
      let file: ServableFile | null = null;
      if (compressible && !rangeRequest) {
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
        !rangeRequest &&
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
      // Advertise range support (RFC 9110 §14.3) on any identity response — a
      // HEAD mirrors GET's headers, so an identity HEAD carries it too. An
      // encoded response (a disk variant or an on-the-fly compressor, both of
      // which set `encoding`) omits it: a range is served identity-only, and a
      // range over chunked output is not expressible in the first place.
      if (ranges && !encoding) {
        headers["Accept-Ranges"] = "bytes";
      }
      if (varyOnEncoding && compressible) {
        // Also set on the identity response: shared caches must key on the
        // header either way.
        headers["Vary"] = "Accept-Encoding";
      }
      if (cacheControl) {
        headers["Cache-Control"] = cacheControl;
      }
      // Validators over the representation actually served (`file`): the variant
      // when one won, the identity file otherwise, with the negotiated encoding
      // folded into the ETag. HTTP dates are second-granular, so `Last-Modified`
      // and every comparison against it run at that precision.
      let etagValue = "";
      if (etag) {
        etagValue = computeETag(file.size, file.mtimeMs, encoding);
        headers["ETag"] = etagValue;
      }
      // A future mtime (clock skew, a deliberately post-dated file) must not
      // become a future `Last-Modified`, or an `If-Modified-Since` bearing it
      // would match until real time catches up. RFC 9110 §8.8.2 caps it at the
      // response's origination time.
      const lastModifiedMs = Math.min(
        Math.floor(file.mtimeMs / 1000) * 1000,
        Math.floor(Date.now() / 1000) * 1000,
      );
      if (lastModified) {
        headers["Last-Modified"] = new Date(lastModifiedMs).toUTCString();
      }
      // A conditional request that still matches needs no body. `If-None-Match`
      // takes precedence over `If-Modified-Since` (RFC 9110 §13.2.2): its very
      // presence suppresses the date check — even with `etag` off, where no tag
      // is emitted so only `*` can match — and a match answers GET/HEAD with
      // `304` but any other configured method with `412` (precondition failed).
      // `If-Modified-Since` is a GET/HEAD-only validator (RFC 9110 §13.1.3), so
      // it is never evaluated for the other methods.
      const conditionalGet = req.method === "GET" || req.method === "HEAD";
      let conditionalStatus = 0;
      const ifNoneMatch = req.headers.get("if-none-match");
      if (ifNoneMatch !== null) {
        if (matchesIfNoneMatch(ifNoneMatch, etagValue)) {
          conditionalStatus = conditionalGet ? 304 : 412;
        }
      } else if (lastModified && conditionalGet) {
        if (matchesIfModifiedSince(req.headers.get("if-modified-since"), lastModifiedMs)) {
          conditionalStatus = 304;
        }
      }
      if (conditionalStatus) {
        await file.handle.close().catch(() => {});
        // Both statuses drop the representation headers
        // (`Content-Type`/`-Length`/`-Encoding`) and the body — a `304` tells the
        // client to reuse the copy it has, a `412` that its precondition failed —
        // while keeping the validators and `Vary` a `200` would carry.
        const conditionalHeaders: Record<string, string> = {};
        if (etagValue) {
          conditionalHeaders["ETag"] = etagValue;
        }
        if (headers["Last-Modified"]) {
          conditionalHeaders["Last-Modified"] = headers["Last-Modified"];
        }
        if (headers["Vary"]) {
          conditionalHeaders["Vary"] = headers["Vary"];
        }
        // A 304 refreshes the client's stored freshness, so carry Cache-Control
        // (RFC 9110 §15.4.5). A 412 is a plain error and gets none.
        if (cacheControl && conditionalStatus === 304) {
          conditionalHeaders["Cache-Control"] = cacheControl;
        }
        return new FastResponse(null, { status: conditionalStatus, headers: conditionalHeaders });
      }
      // Range evaluation runs only after the conditionals above pass (RFC 9110
      // §13.2.2): a 304/412 outranks a 206. `rangeRequest` is already GET-only
      // and identity-only (negotiation was skipped), so `headers` here is the
      // full 200's, minus a body.
      if (rangeRequest) {
        // `If-Range` (RFC 9110 §13.1.5) guards the range against a changed
        // representation. Its entity-tag form demands a *strong* comparison, and
        // our tags are weak, so it never matches — the range is dropped for a
        // full 200. The HTTP-date form is a strong comparison that matches only
        // the exact second we emit as `Last-Modified`; validated against
        // `lastModifiedMs` regardless of the `lastModified` option, since an
        // exact-second match can only reproduce a date the server itself sent.
        const ifRange = req.headers.get("if-range");
        if (ifRange === null || matchesIfRange(ifRange, lastModifiedMs)) {
          const parsed = parseRange(rangeRequest, file.size);
          if (parsed === "unsatisfiable") {
            await file.handle.close().catch(() => {});
            // A 416 is a plain error: like the 412 path it drops the
            // representation headers and validators, keeping only the
            // `Content-Range` that reports the valid extent (`*`/size).
            return new FastResponse(null, {
              status: 416,
              headers: { "Content-Range": `bytes */${file.size}` },
            });
          }
          if (parsed) {
            // Node's `end` is inclusive, matching the byte range's own bounds.
            const stream = file.handle.createReadStream({ start: parsed.start, end: parsed.end });
            return new FastResponse(stream as any, {
              status: 206,
              headers: {
                ...headers,
                "Content-Range": `bytes ${parsed.start}-${parsed.end}/${file.size}`,
                "Content-Length": (parsed.end - parsed.start + 1).toString(),
              },
            });
          }
          // `parsed === null`: malformed, multi-range, or otherwise ignorable —
          // fall through to the full 200 below.
        }
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
    // No file matched. With `dirListing` on, a request naming a directory (root, a
    // trailing-slash path, or an extension-less one) that has no index is
    // answered with a listing rather than falling through. An index always wins:
    // its `index.html` candidate was probed in the loop above.
    if (dirListing && (path === "" || trailingSlash || extname(path) === "")) {
      const entries = await readListing(path);
      if (entries) {
        const base = url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          // A generated listing should never be indexed; mirrors the `robots`
          // meta tag for crawlers that only read headers.
          "X-Robots-Tag": "noindex, nofollow",
        };
        // HEAD mirrors GET's headers without the body.
        const body = req.method === "HEAD" ? null : renderDirListing(base, path, entries);
        return new FastResponse(body, { headers });
      }
    }
    return next();
  };
};

// --- internal ---

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escape text before interpolating it into the listing HTML — a filename is
// attacker-controllable and lands in both element text and an `href` attribute.
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

// A minimal directory listing. `base` is the request pathname with a guaranteed
// trailing slash, so every entry href is an absolute path that resolves the same
// whether the directory was requested with a trailing slash or without.
// `displayPath` is the decoded relative path, shown in the heading.
function renderDirListing(
  base: string,
  displayPath: string,
  entries: { name: string; dir: boolean }[],
): string {
  const heading = escapeHtml("/" + (displayPath ? displayPath + "/" : ""));
  const items: string[] = [];
  // A parent link everywhere but the root. `base` ends in `/`, so relative `../`
  // climbs one segment. Shown as a folder, since it navigates up to one.
  if (displayPath !== "") {
    items.push(row("../", "../", true));
  }
  for (const entry of entries) {
    const suffix = entry.dir ? "/" : "";
    // `encodeURIComponent` before `escapeHtml`: the first makes the name a safe
    // URL path segment (a literal `/` in a name is encoded, never a separator),
    // the second makes that URL safe inside the attribute. The trailing `/` for
    // a directory is appended after encoding so it stays a real separator.
    const href = base + encodeURIComponent(entry.name) + suffix;
    items.push(row(href, entry.name + suffix, entry.dir));
  }
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // A generated listing is not content to index; the `X-Robots-Tag` header
    // set alongside covers crawlers that skip the markup.
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>Index of ${heading}</title>` +
    `<style>` +
    `:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--link:#0969da;--hover:#f6f8fa}` +
    // Follow the OS theme — a plain palette swap, no toggle.
    `@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--link:#4493f8;--hover:#161b22}}` +
    `*{box-sizing:border-box}` +
    `body{font-family:system-ui,-apple-system,sans-serif;line-height:1.5;margin:0;` +
    `padding:2rem 1.25rem;color:var(--fg);background:var(--bg)}` +
    `main{max-width:48rem;margin:0 auto}` +
    `h1{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;` +
    `font-weight:600;color:var(--muted);margin:0 0 1rem;word-break:break-all}` +
    `ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:.625rem;overflow:hidden}` +
    `li+li{border-top:1px solid var(--line)}` +
    `a{display:flex;gap:.625rem;align-items:center;padding:.55rem .875rem;` +
    `text-decoration:none;color:var(--link)}` +
    `a:hover{background:var(--hover)}` +
    `.i{flex:none;width:1.25rem;text-align:center}` +
    `</style></head>` +
    `<body><main><h1>Index of ${heading}</h1><ul>${items.join("")}</ul></main></body></html>`
  );
}

// One listing row. `href` is a raw (unescaped) URL and `label` raw text; both
// are escaped here before landing in the attribute and element text. The icon
// is a fixed emoji, so it needs none.
function row(href: string, label: string, dir: boolean): string {
  const icon = dir ? "📁" : "📄";
  return `<li><a href="${escapeHtml(href)}"><span class="i">${icon}</span>${escapeHtml(label)}</a></li>`;
}

// The `Cache-Control` value, or "" when `maxAge` is unset so the header is
// omitted entirely. `max-age` takes non-negative integer seconds, so a
// fractional or negative `maxAge` is floored and clamped, non-finite values fall
// back to 0, and the result is capped at the RFC 9111 recommended ceiling of
// 2^31 seconds. `immutable` only has meaning next to a lifetime, so it is
// dropped when `maxAge` is unset.
function buildCacheControl(maxAge: number | undefined, immutable: boolean | undefined): string {
  if (maxAge === undefined) {
    return "";
  }
  const seconds = Number.isFinite(maxAge)
    ? Math.min(2147483648, Math.max(0, Math.floor(maxAge)))
    : 0;
  return immutable ? `max-age=${seconds}, immutable` : `max-age=${seconds}`;
}

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

// A weak validator over the served representation. Weak (`W/`), not strong: an
// on-the-fly encode is not byte-stable across runs. The one cost is `If-Range`,
// whose entity-tag form requires a strong comparison — a range request carrying
// one of these tags never matches, so the client falls back to a full 200 — but
// that is the right trade for a tag derived from size and mtime rather than the
// bytes. Size and mtime pin the file; the encoding is folded in so a gzip and a
// brotli response under one URL never collide, which a cache keying on `Vary`
// relies on.
function computeETag(size: number, mtimeMs: number, encoding: string): string {
  const tag = `${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}`;
  return `W/"${encoding ? `${tag}-${encoding}` : tag}"`;
}

// RFC 9110 §13.1.2 — a weak comparison, since our tags are weak, so an optional
// `W/` prefix is stripped from each candidate before matching. `*` matches any
// current representation. With ETags off (`etag` empty) there is no tag to
// compare, so only `*` can match.
function matchesIfNoneMatch(header: string, etag: string): boolean {
  if (header.trim() === "*") {
    return true;
  }
  if (!etag) {
    return false;
  }
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

// The file is unchanged if its mtime is at or before the client's copy.
// `lastModifiedMs` is already floored to the second (matching the HTTP date we
// send), so a sub-second mtime never reads as newer than the date it produced.
function matchesIfModifiedSince(header: string | null, lastModifiedMs: number): boolean {
  if (!header) {
    return false;
  }
  const since = Date.parse(header);
  return !Number.isNaN(since) && lastModifiedMs <= since;
}

// RFC 9110 §13.1.5 — whether an `If-Range` lets the range apply. The entity-tag
// form (a value opening with `"` or `W/`) requires a strong comparison, which
// our weak tags can never pass, so it always drops the range to a full 200. The
// HTTP-date form is a strong date comparison, taken literally: the only date a
// client can legitimately hold is the IMF-fixdate this middleware emitted as
// `Last-Modified`, so match that exact string — not whatever `Date.parse` also
// accepts (an ISO timestamp naming the same second included). A failure here is
// never an error status — it just serves the whole representation.
function matchesIfRange(header: string, lastModifiedMs: number): boolean {
  const value = header.trim();
  if (value.startsWith('"') || value.startsWith("W/")) {
    return false;
  }
  return value === new Date(lastModifiedMs).toUTCString();
}

// Parse a single `Range: bytes=...` against `size` (the fd's `fstat`, the bytes
// actually served — not the earlier `stat` probe). Returns the inclusive
// `{ start, end }` to serve, `"unsatisfiable"` for a `416`, or `null` to ignore
// the header and serve a full `200` (malformed syntax, a non-`bytes` unit, or a
// syntactically valid multi-range, which RFC 9110 §14.2 lets a server answer in
// full). RFC 9110 §14.1.2.
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  // One anchored pattern is the whole grammar: the `bytes=` unit (re-checked so
  // the helper stands alone), then digits-or-empty on each side of the dash. A
  // non-`bytes` unit, malformed syntax, and a multi-range set (a comma can't
  // match `\d*`) all fall out as a non-match.
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) {
    return null;
  }
  const startStr = match[1]!;
  const endStr = match[2]!;
  // Suffix form `-N`: the final N bytes. `-0` asks for zero bytes and is
  // unsatisfiable; N past the file size is the whole file. An empty file cannot
  // satisfy any range. (A bare `bytes=-`, both sides empty, is malformed.)
  if (startStr === "") {
    if (endStr === "") {
      return null;
    }
    const n = Number(endStr);
    if (n === 0 || size === 0) {
      return "unsatisfiable";
    }
    return { start: n >= size ? 0 : size - n, end: size - 1 };
  }
  const start = Number(startStr);
  // `A-` runs to the end; `A-B` clamps B to the last byte. `A > B` is malformed.
  let end = size - 1;
  if (endStr !== "") {
    const to = Number(endStr);
    if (to < start) {
      return null;
    }
    if (to < end) {
      end = to;
    }
  }
  // Satisfiable only when the start falls within the file (which also rejects
  // every range on an empty file).
  return start >= size ? "unsatisfiable" : { start, end };
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
