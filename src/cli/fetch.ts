import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";

import { loadServerEntry, type LoadOptions } from "../loader.ts";
import type { CLIOptions } from "./types.ts";
import type { ServerHandler } from "../types.ts";
import { resolve } from "node:path";

export async function cliFetch(
  cliOpts: CLIOptions &
    LoadOptions & {
      loader?: LoadOptions;
      stdin?: typeof process.stdin;
      stdout?: typeof process.stdout;
      stderr?: typeof process.stderr;
    },
): Promise<Response> {
  const stdin = cliOpts.stdin || process.stdin;
  const stdout = cliOpts.stdout || process.stdout;
  const stderr = cliOpts.stderr || process.stderr;

  let fetchHandler: ServerHandler = globalThis.fetch;

  let inputURL = cliOpts.url || "/";

  if (inputURL[0] === "/") {
    const loaded = await loadServerEntry({
      dir: cliOpts.dir,
      entry: cliOpts.entry,
      ...cliOpts?.loader,
    });
    if (cliOpts.verbose && loaded.url) {
      stderr.write(`* Entry: ${fileURLToPath(loaded.url)}\n`);
      if (loaded.nodeCompat) {
        stderr.write(`* Using node compat mode\n`);
      }
    }
    if (loaded.notFound) {
      throw new Error(`Server entry file not found in ${resolve(cliOpts.dir || ".")}`, {
        cause: {
          dir: cliOpts.dir || process.cwd(),
          entry: cliOpts.entry || undefined,
        },
      });
    } else if (!loaded.fetch) {
      throw new Error("No fetch handler exported", {
        cause: {
          dir: cliOpts.dir || process.cwd(),
          entry: cliOpts.entry || undefined,
          loaded,
        },
      });
    }
    fetchHandler = loaded.fetch;
  } else {
    stderr.write(`* Fetching remote URL: ${inputURL}\n`);
    if (!URL?.canParse(inputURL)) {
      inputURL = `http${cliOpts.tls ? "s" : ""}://${inputURL}`;
    }
    fetchHandler = globalThis.fetch;
  }

  // Build Headers
  const headers = new Headers();
  if (cliOpts.header) {
    for (const header of cliOpts.header) {
      const colonIndex = header.indexOf(":");
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).trim();
        const value = header.slice(colonIndex + 1).trim();
        headers.append(name, value);
      }
    }
  }
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "srvx (curl)");
  }
  if (!headers.has("Accept")) {
    headers.set(
      "Accept",
      "text/markdown, application/json;q=0.9, text/plain;q=0.8, text/html;q=0.7, text/*;q=0.6, */*;q=0.5",
    );
  }

  // Build body
  let body: BodyInit | undefined;
  if (cliOpts.data !== undefined) {
    if (cliOpts.data === "@-") {
      // Read from stdin
      body = new ReadableStream({
        async start(controller) {
          for await (const chunk of stdin) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    } else if (cliOpts.data.startsWith("@")) {
      // Read from file as stream
      body = Readable.toWeb(createReadStream(cliOpts.data.slice(1))) as unknown as ReadableStream;
    } else {
      body = cliOpts.data;
    }
  }

  // Build request
  const method = cliOpts.method || (body === undefined ? "GET" : "POST");
  const url = new URL(
    inputURL,
    `http${cliOpts.tls ? "s" : ""}://${cliOpts.host || cliOpts.hostname || "localhost"}`,
  );
  const req = new Request(url, {
    method,
    headers,
    body,
  });

  // Verbose: print request info
  if (cliOpts.verbose) {
    const parsedUrl = new URL(url);
    stderr.write(`> ${method} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\n`);
    stderr.write(`> Host: ${parsedUrl.host}\n`);
    for (const [name, value] of headers) {
      stderr.write(`> ${name}: ${value}\n`);
    }
    stderr.write(">\n");
  }

  const res = await fetchHandler(req);

  // Verbose: print response info
  if (cliOpts.verbose) {
    stderr.write(`< HTTP/1.1 ${res.status} ${res.statusText}\n`);
    for (const [name, value] of res.headers) {
      stderr.write(`< ${name}: ${value}\n`);
    }
    stderr.write("<\n");
  }

  // Stream response to stdout
  if (res.body) {
    const { isBinary, encoding } = getResponseFormat(res);

    if (isBinary) {
      // Stream binary directly to stdout
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        stdout.write(chunk);
      }
    } else {
      // Stream text with proper encoding
      const decoder = new TextDecoder(encoding);
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        stdout.write(decoder.decode(chunk, { stream: true }));
      }
      // Flush any remaining bytes
      const remaining = decoder.decode();
      if (remaining) {
        stdout.write(remaining);
      }
      // Add trailing newline for text content when interactive
      // (avoid changing byte-for-byte output in scripts/pipes)
      if (stdout.isTTY) {
        stdout.write("\n");
      }
    }
  }

  return res;
}

function getResponseFormat(res: Response): {
  isBinary: boolean;
  encoding: string;
} {
  const contentType = res.headers.get("content-type") || "";
  const isBinary =
    contentType.startsWith("application/octet-stream") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("application/zip") ||
    contentType.startsWith("application/gzip");
  const encoding = contentType.includes("charset=")
    ? contentType.split("charset=")[1].split(";")[0].trim()
    : "utf8";
  return { isBinary, encoding };
}
