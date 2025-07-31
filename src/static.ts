import type { ServerPlugin } from "./types.ts";
import { extname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { FastResponse } from "srvx";

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

export const serveStatic = (options: ServeStaticOptions): ServerPlugin => {
  const dir = resolve(options.dir) + "/";

  return (server) => {
    server.options.middleware.push(async (req, next) => {
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
          const stream = createReadStream(filePath);
          return new FastResponse(stream as any, {
            headers: {
              "Content-Length": fileStat.size.toString(),
              "Content-Type":
                COMMON_MIME_TYPES[extname(filePath)] ||
                "application/octet-stream",
            },
            status: 200,
          });
        }
      }
      return next();
    });
  };
};
