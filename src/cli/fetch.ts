import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";

import { loadServerEntry, type LoadOptions } from "../loader.ts";
import type { CLIOptions } from "./types.ts";

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
    if (URL.canParse?.(cliOpts.url || "")) {
      stderr.write(
        `* WARNING: server entry file not found. Falling back to network fetch for URL: ${cliOpts.url}\n`,
      );
      loaded.fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("Server entry file not found.", {
        cause: {
          dir: cliOpts.dir || process.cwd(),
          entry: cliOpts.entry || undefined,
        },
      });
    }
  } else if (!loaded.fetch) {
    throw new Error("No fetch handler exported", {
      cause: {
        dir: cliOpts.dir || process.cwd(),
        entry: cliOpts.entry || undefined,
        loaded,
      },
    });
  }

  // Build request URL
  const url = new URL(
    cliOpts.url || "/",
    `http${cliOpts.tls ? "s" : ""}://${cliOpts.host || "localhost"}`,
  ).toString();

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
    headers.set("User-Agent", "curl/7.81.0");
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "text/markdown, text/plain, text/html, text/*;q=0.9, */*;q=0.8");
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

  const method = cliOpts.method || (body === undefined ? "GET" : "POST");

  // Build request
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

  const res = await loaded.fetch(req);

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

  if (!res.ok) {
    const err = new Error(`Request failed with status ${res.status} ${res.statusText}`);
    Error.captureStackTrace?.(err, cliFetch);
    throw err;
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
