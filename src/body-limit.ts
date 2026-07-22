// Runtime-agnostic request body size limiting (web streams only, no Node APIs).
// Used by adapters that don't have a native body-size option (Node, Deno) and
// exported publicly (`srvx/body-limit`) so downstream layers (e.g. per-handler
// limits) can enforce the same streaming semantics and error shape.
// Bun enforces natively via `maxRequestBodySize`.

/**
 * Returns a request whose body is size-limited to `maxRequestBodySize`.
 *
 * If the request has no body it is returned unchanged; otherwise it is wrapped
 * in a `Proxy` that routes every body read (`body` / `text` / `json` /
 * `formData` / `arrayBuffer` / `blob` / `bytes` / `bodyUsed`) through a single
 * lazily-created size-limited stream and passes everything else through to the
 * original request. Used for runtimes that have no native body-size option (e.g.
 * Deno) and exported so downstream layers can apply per-handler limits.
 *
 * Proxy-wrapping (rather than rebuilding via `new Request(request, …)`) is
 * deliberate: it preserves the exact object handed in — including srvx's
 * `ServerRequest` augmentation (`runtime`, `waitUntil`, `ip`, `context`, …) —
 * and works on the Node adapter's `ServerRequest`. The returned
 * value is the same type as the input, so `limitRequestBody(req)` on a
 * `ServerRequest` yields a `ServerRequest`.
 *
 * When the request declares a `Content-Length` that already exceeds the limit,
 * the body is rejected early: the original body is cancelled without being read
 * and the returned request's body errors immediately with the
 * {@link createBodyTooLargeError | `413`-style error}. `Content-Length` is only
 * a fast path — it may be absent (chunked transfer encoding) or understated, so
 * the streaming limit is always enforced regardless. A request that overstates
 * its `Content-Length` is rejected on the declared length (a malformed request,
 * matching how e.g. Bun and nginx enforce limits). The error still surfaces when
 * the body is consumed (`request.text()` / `.json()` / `.arrayBuffer()` /
 * `.body`), matching the streamed-limit behaviour.
 *
 * @see https://srvx.h3.dev/guide/body-limit
 */
export function limitRequestBody<T extends Request>(request: T, maxRequestBodySize: number): T {
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

  // Captured before the over-limit cancel below disturbs the original body, so
  // `bodyUsed` reports the request's real used-state (not our own cancellation)
  // and never regresses from `true` back to `false`.
  const initiallyUsed = request.bodyUsed;

  const overLimit = contentLength > maxRequestBodySize;
  if (overLimit) {
    // Cancel the original body up front (without reading it), matching the
    // rejected-early contract even if the returned request is never consumed.
    request.body.cancel(createBodyTooLargeError(maxRequestBodySize)).catch(() => {});
  }

  // A `Response` fronts the size-limited stream so every read method resolves
  // through one shared, already-spec-compliant body implementation. Built lazily
  // so an unconsumed limited request stays allocation-light, and cached so
  // repeated `body` / read-method access observes one consistent body.
  let limited: Response | undefined;
  const limitedBody = (): Response =>
    (limited ??= new Response(
      overLimit
        ? erroredStream(createBodyTooLargeError(maxRequestBodySize))
        : limitBodyStream(request.body!, maxRequestBodySize),
    ));

  return new Proxy(request, {
    get(target, prop) {
      if (prop === "body") {
        return limitedBody().body;
      }
      if (prop === "bodyUsed") {
        // The wrapper's body is `limited`; it is disturbed only once consumed
        // through the proxy. `initiallyUsed` carries over an input that was
        // already read before wrapping.
        return initiallyUsed || (limited?.bodyUsed ?? false);
      }
      if (typeof prop === "string" && bodyReadMethods.has(prop)) {
        return () => (limitedBody() as any)[prop]();
      }
      if (prop === "clone") {
        // Re-apply the limit to the clone so it can't be used to read an
        // unbounded body (the pre-proxy rebuild tee'd the limited stream, so
        // `clone()` stayed limited). Cloning after the body has been routed
        // through `limited` throws, matching native `Request.clone()` semantics.
        return () => limitRequestBody(target.clone() as T, maxRequestBodySize);
      }
      // Read from the original with `target` as the receiver (never the proxy):
      // `ServerRequest` getters and native `Request` methods reach for internal
      // state / private fields and would throw if invoked on the proxy. Bind
      // methods to `target` for the same reason.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
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

/** Body-reading methods routed through the size-limited body by {@link limitRequestBody}. */
const bodyReadMethods = /* @__PURE__ */ new Set([
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
]);

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

/** A `ReadableStream` that errors immediately with `error`, without producing any bytes. */
function erroredStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}
