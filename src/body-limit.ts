// Runtime-agnostic request body size limiting (web streams only, no Node APIs).
// Used by adapters that don't have a native body-size option (Node, Deno) and
// exported publicly (`srvx/body-limit`) so downstream layers (e.g. per-handler
// limits) can enforce the same streaming semantics and error shape.
// Bun enforces natively via `maxRequestBodySize`.

/**
 * The canonical error thrown when a request body exceeds `maxRequestBodySize`.
 *
 * It carries a stable, documented shape so any layer can map it to an HTTP
 * `413 Payload Too Large` response without string matching.
 *
 * @see https://srvx.h3.dev/guide/body-limit
 */
export interface BodyTooLargeError extends Error {
  /** Stable machine-readable code. */
  code: "ERR_BODY_TOO_LARGE";
  /** HTTP status to respond with. */
  statusCode: 413;
  /** Alias of {@link statusCode}. */
  status: 413;
}

/**
 * Creates the canonical {@link BodyTooLargeError | `413 Payload Too Large` error}
 * used across srvx when a request body exceeds the configured `maxRequestBodySize`.
 *
 * @see https://srvx.h3.dev/guide/body-limit
 */
export function createBodyTooLargeError(maxRequestBodySize: number): BodyTooLargeError {
  return Object.assign(
    new Error(`Request body exceeds the maximum allowed size of ${maxRequestBodySize} bytes.`),
    { code: "ERR_BODY_TOO_LARGE", statusCode: 413, status: 413 } as const,
  );
}

/**
 * Wraps a body `ReadableStream` so the total number of bytes read cannot exceed
 * `maxRequestBodySize`.
 *
 * The wrapper is **pull-based**: it reads from the upstream stream only when the
 * consumer pulls, so it preserves backpressure and never buffers the whole body.
 * As soon as the accumulated size passes the limit, the wrapped stream errors
 * with the {@link createBodyTooLargeError | `413`-style error} and the upstream
 * stream is cancelled with that same error (so the underlying source can stop
 * producing / release the socket). Cancelling the wrapped stream propagates to
 * the upstream stream.
 *
 * @see https://srvx.h3.dev/guide/body-limit
 */
export function limitBodyStream(
  stream: ReadableStream<Uint8Array>,
  maxRequestBodySize: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      size += value.byteLength;
      if (size > maxRequestBodySize) {
        const error = createBodyTooLargeError(maxRequestBodySize);
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
 * Returns a `Request` whose body is size-limited to `maxRequestBodySize`.
 *
 * If the request has no body it is returned unchanged; otherwise it is rebuilt
 * with a size-limited body stream (method, url, headers and signal are
 * preserved). Used for runtimes that expose a native `Request` but no body-size
 * option (e.g. Deno).
 *
 * When the request declares a `Content-Length` that already exceeds the limit,
 * the body is rejected early: the original body is cancelled without being read
 * and the returned request's body errors immediately with the
 * {@link createBodyTooLargeError | `413`-style error}. `Content-Length` is only
 * a fast path — it may be absent (chunked transfer encoding) or understated, so
 * the streaming limit is always enforced regardless. The error still surfaces
 * when the body is consumed (`request.text()` / `.json()` / `.arrayBuffer()` /
 * `.body`), matching the streamed-limit behaviour.
 *
 * @see https://srvx.h3.dev/guide/body-limit
 */
export function limitRequestBody(request: Request, maxRequestBodySize: number): Request {
  if (!request.body) {
    return request;
  }

  // Fast path: reject before reading a single byte when the declared size is
  // already over the limit. `Content-Length` is `1*DIGIT` per HTTP, so anything
  // else (absent, empty, decimal, hex, `Infinity`, whitespace) is treated as
  // unavailable and falls through to the authoritative streaming limit.
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength =
    contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : Number.NaN;
  if (contentLength > maxRequestBodySize) {
    const error = createBodyTooLargeError(maxRequestBodySize);
    request.body.cancel(error).catch(() => {});
    return new Request(request, {
      // oxlint-disable-next-line no-invalid-fetch-options -- guarded by `request.body` above, so never GET/HEAD
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      }),
      // @ts-expect-error `duplex` is required for a streaming request body.
      duplex: "half",
    });
  }

  return new Request(request, {
    // oxlint-disable-next-line no-invalid-fetch-options -- guarded by `request.body` above, so never GET/HEAD
    body: limitBodyStream(request.body, maxRequestBodySize),
    // @ts-expect-error `duplex` is required for a streaming request body.
    duplex: "half",
  });
}
