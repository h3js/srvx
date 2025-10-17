import type { Readable as NodeReadable } from "node:stream";
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
  if ((webRes as NodeResponse).nodeResponse) {
    const res = (webRes as NodeResponse).nodeResponse();
    writeHead(nodeRes, res.status, res.statusText, res.headers.flat());
    if (res.body) {
      if (res.body instanceof ReadableStream) {
        return streamBody(res.body, nodeRes);
      } else if (typeof (res.body as NodeReadable)?.pipe === "function") {
        (res.body as NodeReadable).pipe(nodeRes);
        return new Promise((resolve) => nodeRes.on("close", resolve));
      }
      // Note: NodeHttp2ServerResponse.write() body type declared as string | Uint8Array
      // We explicitly test other types in runtime.
      (nodeRes as NodeHttp.ServerResponse).write(res.body);
    }
    return endNodeResponse(nodeRes);
  }

  const headerEntries: NodeHttp.OutgoingHttpHeader[] = [];
  for (const [key, value] of webRes.headers) {
    headerEntries.push([key, value]);
  }

  writeHead(nodeRes, webRes.status, webRes.statusText, headerEntries.flat());

  return webRes.body
    ? streamBody(webRes.body, nodeRes)
    : endNodeResponse(nodeRes);
}

function writeHead(
  nodeRes: NodeServerResponse,
  status: number,
  statusText: string,
  headers: NodeHttp.OutgoingHttpHeader[],
): void {
  if (!nodeRes.headersSent) {
    if (nodeRes.req?.httpVersion === "2.0") {
      nodeRes.writeHead(status, headers.flat() as any);
    } else {
      nodeRes.writeHead(status, statusText, headers.flat() as any);
    }
  }
}

function endNodeResponse(nodeRes: NodeServerResponse) {
  return new Promise<void>((resolve) => nodeRes.end(resolve));
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
        nodeRes.once("drain", () =>
          reader.read().then(streamHandle, streamCancel),
        );
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
  return reader.closed.finally(() => {
    // cleanup listeners
    nodeRes.off("close", streamCancel);
    nodeRes.off("error", streamCancel);
  });
}
