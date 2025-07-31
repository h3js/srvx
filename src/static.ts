import type { ServerMiddleware } from "./types.ts";
import type { Transform } from "node:stream";

import { extname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream, ReadStream } from "node:fs";
import { FastResponse } from "srvx";
import { createGzip, createBrotliCompress } from "node:zlib";

export interface ServeStaticOptions {
  dir: string;
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
  ".gif": "image/gif",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
};

export const serveStatic = (options: ServeStaticOptions): ServerMiddleware => {
  const dir = resolve(options.dir) + "/";

  return async (req, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }
    const path = new URL(req.url).pathname.slice(1).replace(/\/$/, "");
    let paths: string[];
    if (path === "") {
      paths = ["index.html"];
    } else if (extname(path) === "") {
      paths = [`${path}.html`, `${path}/index.html`];
    } else {
      paths = [path];
    }
    for (const path of paths) {
      const filePath = join(dir, path);
      if (!filePath.startsWith(dir)) {
        continue;
      }
      const fileStat = await stat(filePath).catch(() => null);
      if (fileStat?.isFile()) {
        const headers: HeadersInit = {
          "Content-Length": fileStat.size.toString(),
          "Content-Type":
            COMMON_MIME_TYPES[extname(filePath)] || "application/octet-stream",
        };
        let stream: ReadStream | Transform = createReadStream(filePath);
        const acceptEncoding = req.headers.get("accept-encoding") || "";
        if (acceptEncoding.includes("br")) {
          headers["Content-Encoding"] = "br";
          delete headers["Content-Length"];
          headers["Vary"] = "Accept-Encoding";
          stream = stream.pipe(createBrotliCompress());
        } else if (acceptEncoding.includes("gzip")) {
          headers["Content-Encoding"] = "gzip";
          delete headers["Content-Length"];
          headers["Vary"] = "Accept-Encoding";
          stream = stream.pipe(createGzip());
        }
        return new FastResponse(stream as any, { headers });
      }
    }
    return next();
  };
};
