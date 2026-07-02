// Runtime-agnostic request body size limiting (web streams only, no Node APIs).
// Used by adapters that don't have a native body-size option (Node, Deno).
// Bun enforces natively via `maxRequestBodySize`.

/**
 * Creates a `413 Payload Too Large` style error for when a request body exceeds
 * the configured `maxBodySize`. The `statusCode` / `status` properties let a
 * handler map it to an HTTP 413 response.
 */
export function createBodyTooLargeError(maxBodySize: number): Error {
  return Object.assign(
    new Error(`Request body exceeds the maximum allowed size of ${maxBodySize} bytes.`),
    { code: "ERR_BODY_TOO_LARGE", statusCode: 413, status: 413 },
  );
}

/**
 * Wraps a body `ReadableStream` so the total number of bytes read cannot exceed
 * `maxBodySize`. Once the limit is passed the wrapped stream errors with a
 * `413`-style error and the upstream stream is cancelled. This is pull-based, so
 * it preserves backpressure and stops reading as soon as the limit is hit rather
 * than buffering the whole body first.
 */
export function limitBodyStream(stream: ReadableStream, maxBodySize: number): ReadableStream {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      size += (value as Uint8Array).byteLength;
      if (size > maxBodySize) {
        const error = createBodyTooLargeError(maxBodySize);
        reader.cancel(error).catch(() => {});
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Returns a `Request` whose body is size-limited to `maxBodySize`. If the request
 * has no body it is returned unchanged; otherwise it is rebuilt with a limited
 * body stream (method, url, headers and signal are preserved). Used for runtimes
 * that expose a native `Request` but no body-size option (e.g. Deno).
 */
export function limitRequestBody(request: Request, maxBodySize: number): Request {
  if (!request.body) {
    return request;
  }
  return new Request(request, {
    body: limitBodyStream(request.body, maxBodySize),
    // @ts-expect-error `duplex` is required for a streaming request body.
    duplex: "half",
  });
}
