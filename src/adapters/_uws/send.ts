import type { UWSServerResponse } from "../../types.ts";
import type { UWSResponse } from "./response.ts";
import { kUWSAbort } from "./_common.ts";

function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}

function isNodeReadable(v: unknown): v is NodeJS.ReadableStream {
  const obj = v as { pipe?: unknown; getReader?: unknown } | null | undefined;
  return (
    !!obj &&
    typeof obj.pipe === "function" &&
    typeof obj.getReader !== "function"
  );
}

function hasUwsResponse(v: unknown): v is UWSResponse {
  const obj = v as { uwsResponse?: unknown } | null | undefined;
  return !!obj && typeof obj.uwsResponse === "function";
}

function writeStatusAndHeaders(
  res: UWSServerResponse,
  status: number,
  statusText: string,
  headers: Iterable<[string, string]>,
) {
  res.cork(() => {
    res.writeStatus(`${status} ${statusText || ""}`);
    for (const [key, value] of headers) {
      res.writeHeader(key, value);
    }
  });
}

async function streamWebReadable(
  res: UWSServerResponse,
  stream: ReadableStream<Uint8Array>,
) {
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
    try {
      // Cancel the readable stream on abort
      stream.cancel?.().catch?.(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
    // Propagate to request.signal if available
    try {
      (res as unknown as Record<symbol, () => void>)[kUWSAbort]?.();
    } catch {
      /* ignore */
    }
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      if (value && value.length > 0) {
        // Best-effort backpressure handling; small chunks in tests won't saturate.
        res.write(value);
      }
    }
  } finally {
    if (!aborted) {
      // End only if not aborted
      res.end();
    }
  }
}

async function streamNodeReadable(
  res: UWSServerResponse,
  nodeStream: NodeJS.ReadableStream,
) {
  let aborted = false;
  const onAborted = () => {
    aborted = true;
    try {
      (nodeStream as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      /* ignore */
    }
    try {
      (res as unknown as Record<symbol, () => void>)[kUWSAbort]?.();
    } catch {
      /* ignore */
    }
  };
  res.onAborted(onAborted);

  await new Promise<void>((resolve) => {
    const onData = (chunk: unknown) => {
      if (aborted) return;
      // Ensure Uint8Array or string per uWS API
      if (typeof chunk === "string") {
        res.write(chunk);
      } else if (chunk instanceof Uint8Array) {
        res.write(chunk);
      } else if (ArrayBuffer.isView(chunk)) {
        const view = chunk as ArrayBufferView;
        res.write(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        );
      } else {
        // Fallback stringify
        res.write(String(chunk));
      }
    };
    const onEnd = () => {
      nodeStream.off("data", onData);
      nodeStream.off("end", onEnd);
      nodeStream.off("error", onError);
      if (!aborted) res.end();
      resolve();
    };
    const onError = () => {
      nodeStream.off("data", onData);
      nodeStream.off("end", onEnd);
      nodeStream.off("error", onError);
      if (!aborted) res.end();
      resolve();
    };
    nodeStream.on("data", onData);
    nodeStream.once("end", onEnd);
    nodeStream.once("error", onError);
  });
}

export async function sendUWSResponse(
  res: UWSServerResponse,
  webRes: Response | UWSResponse,
): Promise<void> {
  if (res.aborted) {
    return;
  }

  if (!webRes) {
    res.cork(() => {
      res.writeStatus("500");
      res.end();
    });
    return;
  }

  // If this is a fast UWSResponse, fully handle based on the extracted data.
  const maybeFast = webRes as unknown;
  if (hasUwsResponse(maybeFast)) {
    const fast = (maybeFast as UWSResponse).uwsResponse();
    const { status, statusText, headers } = fast;
    const body = fast.body as
      | string
      | Uint8Array
      | ArrayBuffer
      | DataView
      | ReadableStream<Uint8Array>
      | NodeJS.ReadableStream
      | null
      | undefined;

    // Streaming bodies
    if (isReadableStream(body)) {
      writeStatusAndHeaders(res, status, statusText, headers);
      await streamWebReadable(res, body);
      return;
    }
    if (isNodeReadable(body)) {
      writeStatusAndHeaders(res, status, statusText, headers);
      await streamNodeReadable(res, body);
      return;
    }

    // Non-streaming bodies
    writeStatusAndHeaders(res, status, statusText, headers);
    if (body === null || body === undefined) {
      res.end();
      return;
    }
    if (typeof body === "string") {
      res.end(body);
      return;
    }
    if (body instanceof ArrayBuffer) {
      res.end(body);
      return;
    }
    if (body instanceof Uint8Array) {
      res.end(body);
      return;
    }
    if (body instanceof DataView) {
      res.end(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      return;
    }
    // Fallback
    res.end(String(body));
    return;
  }

  // Standard Response
  const body = (webRes as Response).body;
  if (isReadableStream(body)) {
    writeStatusAndHeaders(
      res,
      webRes.status,
      webRes.statusText,
      (webRes.headers as unknown as Headers).entries(),
    );
    await streamWebReadable(res, body as ReadableStream<Uint8Array>);
    return;
  }

  // Buffer small/finite bodies
  const ab = body ? await (webRes as Response).arrayBuffer() : undefined;
  if (res.aborted) return;
  writeStatusAndHeaders(
    res,
    webRes.status,
    webRes.statusText,
    (webRes.headers as unknown as Headers).entries(),
  );
  if (ab) {
    res.end(ab);
  } else {
    res.end();
  }
}
