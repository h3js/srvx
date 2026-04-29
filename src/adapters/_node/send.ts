import { type Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type NodeHttp from "node:http";
import type { NodeServerResponse } from "../../types.ts";
import type { NodeResponse } from "./response.ts";

export async function sendNodeResponse(
  nodeRes: NodeServerResponse,
  webRes: Response | NodeResponse,
): Promise<void> {
  if (!webRes) {
    nodeRes.statusCode = 500;
    return endNodeResponse(nodeRes);
  }

  // Fast path for NodeResponse
  if ((webRes as NodeResponse)._toNodeResponse) {
    const res = (webRes as NodeResponse)._toNodeResponse();
    if (res.body) {
      if (res.body instanceof ReadableStream) {
        writeHead(nodeRes, res.status, res.statusText, res.headers);
        return streamBody(res.body, nodeRes);
      } else if (typeof (res.body as NodeReadable)?.pipe === "function") {
        // Defer writeHead so pipeBody can detect early stream errors
        return pipeBody(res.body as NodeReadable, nodeRes, res.status, res.statusText, res.headers);
      }
      writeHead(nodeRes, res.status, res.statusText, res.headers);
      // Note: NodeHttp2ServerResponse.write() body type declared as string | Uint8Array
      // We explicitly test other types in runtime.
      (nodeRes as NodeHttp.ServerResponse).write(res.body);
    } else {
      writeHead(nodeRes, res.status, res.statusText, res.headers);
    }
    return endNodeResponse(nodeRes);
  }

  const rawHeaders = [...webRes.headers];
  writeHead(nodeRes, webRes.status, webRes.statusText, rawHeaders);

  return webRes.body ? streamBody(webRes.body, nodeRes) : endNodeResponse(nodeRes);
}

function writeHead(
  nodeRes: NodeServerResponse,
  status: number,
  statusText: string,
  rawHeaders: [string, string][],
): void {
  // Node.js writeHead accepts a raw array of [key, value, key, value] or [[key, value], [key, value]]
  // https://github.com/nodejs/node/blob/v22.14.0/lib/_http_server.js#L376
  // https://github.com/nodejs/node/blob/v24.10.0/lib/_http_outgoing.js#L417
  // But it has an inconsistency in slow-path that does not unflattens!!
  // https://github.com/h3js/srvx/pull/40
  const writeHeaders = rawHeaders.flat();
  if (!nodeRes.headersSent) {
    if (nodeRes.req?.httpVersion === "2.0") {
      // @ts-expect-error
      nodeRes.writeHead(status, writeHeaders);
    } else {
      // @ts-expect-error
      nodeRes.writeHead(status, statusText, writeHeaders);
    }
  }
}

function endNodeResponse(nodeRes: NodeServerResponse) {
  return new Promise<void>((resolve) => nodeRes.end(resolve));
}

function pipeBody(
  stream: NodeReadable,
  nodeRes: NodeServerResponse,
  status: number,
  statusText: string,
  headers: [string, string][],
): Promise<void> | void {
  if (nodeRes.destroyed) {
    stream.destroy?.();
    return;
  }

  // Duck-typed pipe objects (e.g. React's PipeableStream) only have .pipe()
  // and don't support pipeline() — use the raw path.
  if (typeof stream.on !== "function" || typeof stream.destroy !== "function") {
    writeHead(nodeRes, status, statusText, headers);
    stream.pipe(nodeRes as unknown as NodeJS.WritableStream);
    return new Promise<void>((resolve) => nodeRes.on("close", resolve));
  }

  // Real Node.js streams support pipeline() for proper error/abort propagation.
  // Wait for the first event (readable or error) before writing headers so that
  // if the stream errors before producing any data we can respond with 500
  // instead of committing to the original status code.

  // Stream already destroyed/errored — neither 'readable' nor 'error' would fire.
  if (stream.destroyed) {
    writeHead(nodeRes, 500, "Internal Server Error", []);
    return endNodeResponse(nodeRes);
  }

  return new Promise<void>((resolve) => {
    function onEarlyError() {
      stream.off("readable", onReadable);
      stream.destroy();
      writeHead(nodeRes, 500, "Internal Server Error", []);
      endNodeResponse(nodeRes).then(resolve);
    }
    function onReadable() {
      stream.off("error", onEarlyError);
      if (nodeRes.destroyed) {
        stream.destroy();
        return resolve();
      }
      writeHead(nodeRes, status, statusText, headers);
      pipeline(stream, nodeRes as NodeHttp.ServerResponse)
        .catch(() => {})
        .then(() => resolve());
    }
    stream.once("error", onEarlyError);
    stream.once("readable", onReadable);
  });
}

export function streamBody(
  stream: ReadableStream,
  nodeRes: NodeServerResponse,
): Promise<void> | void {
  // stream is already destroyed
  if (nodeRes.destroyed) {
    stream.cancel();
    return;
  }

  const reader = stream.getReader();

  // Cancel the stream and destroy the response
  function streamCancel(error?: Error) {
    reader.cancel(error).catch(() => {});
    if (error) {
      nodeRes.destroy(error);
    }
  }

  function streamHandle({
    done,
    value,
  }: ReadableStreamReadResult<Uint8Array>): void | Promise<void> {
    try {
      if (done) {
        // End the response
        nodeRes.end();
      } else if ((nodeRes as NodeHttp.ServerResponse).write(value)) {
        // Continue reading recursively
        reader.read().then(streamHandle, streamCancel);
      } else {
        // Wait for the drain event to continue reading
        nodeRes.once("drain", () => reader.read().then(streamHandle, streamCancel));
      }
    } catch (error) {
      streamCancel(error instanceof Error ? error : undefined);
    }
  }

  // Listen for close and error events to cancel the stream
  nodeRes.on("close", streamCancel);
  nodeRes.on("error", streamCancel);
  reader.read().then(streamHandle, streamCancel);

  // Return a promise that resolves when the stream is closed
  return reader.closed.catch(streamCancel).finally(() => {
    // cleanup listeners
    nodeRes.off("close", streamCancel);
    nodeRes.off("error", streamCancel);
  });
}
