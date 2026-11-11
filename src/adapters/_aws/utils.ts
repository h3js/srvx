import type { ServerRequest } from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import {
  resolveClientIP,
  trustedHops,
  forwardedHopValue,
  forwardedList,
  isValidHost,
} from "../../_trust-proxy.ts";
import type { ResponseBody } from "../../types.ts";
import type {
  AWSLambdaALBEvent,
  AWSLambdaContext,
  AWSLambdaProxyEvent,
  AWSLambdaProxyEventV2,
  AWSLambdaProxyResult,
  AWSLambdaProxyResultV2,
} from "../../types/aws-lambda.ts";

// Every event shape the adapter accepts (API Gateway v1/v2 and ALB).
type AWSEvent = AWSLambdaProxyEvent | AWSLambdaProxyEventV2 | AWSLambdaALBEvent;

// -- Streaming types --

export interface AWSLambdaStreamResponseMetadata {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  cookies?: string[];
}

export type AWSLambdaResponseStream = NodeJS.WritableStream & {
  setContentType(contentType: string): void;
};

// -- Incoming/Outgoing types --

// `headers` is absent only for ALB multi-value results (see `awsResponseHeaders`).
export interface AWSResponseHeaders {
  headers?: Record<string, string>;
  cookies?: string[];
  multiValueHeaders?: Record<string, string[]>;
}

// Incoming (AWS => Web)

export function awsRequest(
  event: AWSEvent,
  context: AWSLambdaContext,
  trustProxy?: TrustProxyOption,
): ServerRequest {
  // Headers are merged once (see `awsEventHeaders`) and every derivation below
  // reads from them, so lookups are case-insensitive and see repeated lines.
  const headers = awsEventHeaders(event);

  // The gateway-verified `sourceIp` is the nearest hop. Resolve the trusted hop
  // count once (walking `X-Forwarded-For` right-to-left from it) and pass it
  // down; both the URL and the client IP derivation are hop-aware.
  const { sourceIp, forwardedFor } = awsEventPeer(event, headers);
  const hops = trustedHops(trustProxy, sourceIp, forwardedFor);

  // `new Request()` throws for a GET/HEAD with a body, and this runs before the
  // error middleware, so it would fail the whole invocation. ALB forwards such
  // bodies (the AWS docs sample is a GET with `body: "Test"`); a GET/HEAD body
  // has no defined semantics (RFC 9110 §9.3.1), so it is dropped.
  const method = awsEventMethod(event);
  const isBodyless = /^(?:get|head)$/i.test(method);

  const req = new Request(awsEventURL(event, headers, hops), {
    method,
    headers,
    body: isBodyless ? undefined : awsEventBody(event),
  }) as ServerRequest;

  req.runtime = {
    name: "aws-lambda",
    awsLambda: { event, context },
  };

  req.ip = resolveClientIP(trustProxy, sourceIp, forwardedFor);

  return req;
}

function awsEventMethod(event: AWSEvent): string {
  return (
    (event as AWSLambdaProxyEvent).httpMethod ||
    (event as AWSLambdaProxyEventV2).requestContext?.http?.method ||
    "GET"
  );
}

function awsEventIP(event: AWSEvent): string | undefined {
  return (
    (event as AWSLambdaProxyEventV2).requestContext?.http?.sourceIp || // v2 (HTTP API)
    (event as AWSLambdaProxyEvent).requestContext?.identity?.sourceIp // v1 (REST API)
  );
}

// ALB events carry no `sourceIp` (h3js/srvx#314). In the default `append`
// processing mode the load balancer appends the address it accepted the
// connection from as the *last* `X-Forwarded-For` entry, which makes that entry
// the ALB-verified equivalent of `sourceIp`; the entries left of it are what
// the client (or proxies in front of it) claimed, and go through the same
// hop-aware trust walk as on API Gateway. This relies on `append`: in
// `preserve` mode the header is entirely client-controlled, and in `remove`
// mode it is absent (so is the IP). Health checks carry no `X-Forwarded-For`.
// https://docs.aws.amazon.com/elasticloadbalancing/latest/application/x-forwarded-headers.html#x-forwarded-for
function awsEventPeer(
  event: AWSEvent,
  headers: Headers,
): { sourceIp: string | undefined; forwardedFor: string | null } {
  const forwardedFor = headers.get("x-forwarded-for");
  if (!isALBEvent(event)) {
    return { sourceIp: awsEventIP(event), forwardedFor };
  }
  const list = forwardedList(forwardedFor);
  const last = list.pop();
  return {
    sourceIp: last ? stripClientPort(last) : undefined,
    forwardedFor: list.join(", "),
  };
}

// With `routing.http.xff_client_port.enabled` ALB appends `1.2.3.4:8080` or
// `[2001:db8::1]:8080`. A bare IPv6 address has several colons, so only a
// single colon marks an IPv4 port.
function stripClientPort(address: string): string {
  if (address[0] === "[") {
    const end = address.indexOf("]");
    return end === -1 ? address : address.slice(1, end);
  }
  const colon = address.indexOf(":");
  return colon !== -1 && colon === address.lastIndexOf(":") ? address.slice(0, colon) : address;
}

function awsEventURL(event: AWSEvent, headers: Headers, hops: number): URL {
  const rawPath =
    (event as AWSLambdaProxyEvent).path || (event as AWSLambdaProxyEventV2).rawPath || "/";

  // The gateway path is client-controlled and must never contribute the
  // authority. Resolving it as a *relative reference* would let `//evil.com/x`
  // (a protocol-relative reference) or `https://evil.com/x` (absolute form)
  // replace the origin, so it is concatenated after the authority instead and
  // is always forced into origin-form. `//` runs are deliberately preserved
  // rather than collapsed, so the routed `pathname` keeps matching the raw path
  // the gateway saw — same as `NodeRequestURL`.
  const path = rawPath[0] === "/" ? rawPath : `/${rawPath}`;

  const query = awsEventQuery(event);

  // Only honor client-supplied `X-Forwarded-*` headers when the peer is trusted
  // (`hops > 0`); otherwise any client could spoof the host or protocol. `hops`
  // selects the outermost trusted proxy's entry from a comma-joined chain.
  const forwardedHost = forwardedHopValue(headers.get("x-forwarded-host"), hops);

  // A malformed host must neither inject an authority/path into the URL built
  // below nor throw out of `awsRequest` (which runs before the error
  // middleware, so a throw fails the whole invocation). Same `isValidHost` gate and
  // `_invalid_` sentinel as the Node adapter.
  //
  // A `Host` repeated in `multiValueHeaders` is merged into `a, b`, which no
  // host matches; `event.headers` keeps the last one, so that one is used.
  const host =
    (forwardedHost && isValidHost(forwardedHost) ? forwardedHost : undefined) ||
    forwardedList(headers.get("host")).pop() ||
    // ALB has no `domainName`; its events always carry `Host` (health checks
    // excepted, which then get the `_invalid_` sentinel).
    (event as AWSLambdaProxyEvent | AWSLambdaProxyEventV2).requestContext?.domainName;
  const hostname = host && isValidHost(host) ? host : "_invalid_";

  // Assume `https` when untrusted (Lambda is always TLS-terminated at the gateway).
  const forwardedProto = forwardedHopValue(headers.get("x-forwarded-proto"), hops);
  const protocol = forwardedProto === "http" ? "http" : "https";

  return new URL(`${protocol}://${hostname}${path}${query ? `?${query}` : ""}`);
}

function awsEventQuery(event: AWSEvent) {
  if (typeof (event as AWSLambdaProxyEventV2).rawQueryString === "string") {
    return (event as AWSLambdaProxyEventV2).rawQueryString;
  }
  if (isALBEvent(event)) {
    // "If the query parameters are URL-encoded, the load balancer does not
    // decode them" — keys and values arrive percent-encoded as on the wire, so
    // they are joined as-is (encoding them again turned `?q=a%20b` into
    // `?q=a%2520b`, h3js/srvx#314). Multi-value mode sends only
    // `multiValueQueryStringParameters`, single-value mode only
    // `queryStringParameters` (last value wins for a repeated key).
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html#receive-event-from-load-balancer
    return stringifyQuery(
      { ...(event.multiValueQueryStringParameters || event.queryStringParameters) },
      true,
    );
  }
  const queryObj = {
    ...event.queryStringParameters,
    ...(event as AWSLambdaProxyEvent).multiValueQueryStringParameters,
  };
  return stringifyQuery(queryObj);
}

// ALB events carry `requestContext.elb` instead of API Gateway's `identity`/`http`.
function isALBEvent(event: AWSEvent): event is AWSLambdaALBEvent {
  return !!(event as AWSLambdaALBEvent).requestContext?.elb;
}

function awsEventHeaders(event: AWSEvent): Headers {
  const headers = new Headers();

  // API Gateway v1 puts only the last value of a repeated header in `headers`
  // and every value in `multiValueHeaders`, so the latter is the source of truth
  // (h3js/srvx#313). ALB with multi-value headers enabled renames the field to
  // `multiValueHeaders` and sends no `headers` at all (h3js/srvx#314).
  // https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html#multi-value-headers
  const multiValueHeaders = (event as AWSLambdaProxyEvent).multiValueHeaders;
  const fromMultiValue = new Set<string>();
  // Repeated `Cookie` lines (one array entry each on ALB) form one cookie-string
  // joined by `; ` (RFC 6265 §5.4). Undici's `Headers` special-cases `cookie`
  // the same way, but the generic combine rule is `, `, so it is not relied on.
  const cookieLines: string[] = [];
  if (multiValueHeaders) {
    for (const [key, values] of Object.entries(multiValueHeaders)) {
      const name = key.toLowerCase();
      for (const value of values || []) {
        if (!value) {
          continue;
        }
        fromMultiValue.add(name);
        if (name === "cookie") {
          cookieLines.push(value);
        } else {
          headers.append(name, value);
        }
      }
    }
  }
  if (cookieLines.length > 0) {
    headers.set("cookie", cookieLines.join("; "));
  }

  // Fill in whatever `multiValueHeaders` lacks (or everything, when it is
  // absent as on payload 2.0), compared case-insensitively so mixed-case keys
  // do not duplicate a value.
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value && !fromMultiValue.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // Payload 2.0 (HTTP API / Function URL) may carry the same cookies in both
  // `headers.cookie` and the parsed `cookies[]` array. The array is the source
  // of truth when non-empty, so drop the header instead of appending on top of
  // it (which would hand the handler every cookie twice).
  const cookies = "cookies" in event && event.cookies?.length ? event.cookies : undefined;
  if (cookies) {
    headers.delete("cookie");
    for (const cookie of cookies) {
      headers.append("cookie", cookie);
    }
  }
  return headers;
}

export function awsEventBody(event: AWSEvent): ResponseBody | undefined {
  if (!event.body) {
    return undefined;
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body || "", "base64");
  }
  return event.body;
}

// Outgoing (Web => AWS)

export function awsResponseHeaders(response: Response, event?: AWSEvent): AWSResponseHeaders {
  const headers: Record<string, string> = Object.create(null);
  for (const [key, value] of response.headers) {
    // `Headers` iteration yields one entry per `set-cookie`, so a flat record
    // can only keep the last one, while the full list is carried below by
    // `cookies` (v2) or `multiValueHeaders` (v1). v2 applies `cookies` *and*
    // `headers`, so keeping a copy here would send that last cookie twice; v1
    // merges the two records with `multiValueHeaders` winning per key, so there
    // the copy is merely redundant. Neither wants it.
    if (key === "set-cookie") {
      continue;
    }
    if (value) {
      headers[key] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }

  const cookies = response.headers.getSetCookie();

  // ALB only reads `multiValueHeaders` when the target group has multi-value
  // headers enabled ("You must use `multiValueHeaders` if you have enabled
  // multi-value headers and `headers` otherwise"), so a flat record — and every
  // header in it, `content-type` included — would be dropped. That same setting
  // renames the *request* fields, so `multiValueHeaders` on the event is what
  // tells the two configurations apart. Every header goes into the multi-value
  // record and the flat one is left out entirely (as Mangum and Powertools do).
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html#multi-value-headers
  if (event && isALBEvent(event) && event.multiValueHeaders) {
    const multiValueHeaders: Record<string, string[]> = Object.create(null);
    for (const [key, value] of Object.entries(headers)) {
      multiValueHeaders[key] = [value];
    }
    if (cookies.length > 0) {
      multiValueHeaders["set-cookie"] = cookies;
    }
    return { multiValueHeaders };
  }

  if (cookies.length === 0) {
    return { headers };
  }

  const isV2 =
    (event as AWSLambdaProxyEventV2)?.version === "2.0" ||
    !!(event as AWSLambdaProxyEventV2)?.requestContext?.http;

  // `cookies` is a payload 2.0 field (HTTP API / Function URL). The API Gateway
  // REST (v1) proxy result is `statusCode`, `headers`, `multiValueHeaders`,
  // `body` and `isBase64Encoded` — "If the function output is of a different
  // format, API Gateway returns a 502 Bad Gateway error response" — so a stray
  // `cookies` key 502s the whole invocation (unjs/nitro#504). ALB takes the same
  // fields plus `statusDescription` and likewise has no `cookies`.
  if (isV2) {
    return { headers, cookies };
  }

  // An ALB event without `multiValueHeaders` (multi-value handled above) means
  // the flat record is the only channel back, and dropping `set-cookie` from it
  // would lose the cookie entirely. Only one fits, and the docs state the
  // last-wins rule for requests only, so the last cookie is sent on the same
  // principle — and because it is what this adapter sent before.
  if (event && isALBEvent(event)) {
    headers["set-cookie"] = cookies[cookies.length - 1];
    return { headers };
  }

  return { headers, multiValueHeaders: { "set-cookie": cookies } };
}

// AWS Lambda proxy integrations requires base64 encoded buffers
// binaryMediaTypes should be */*
// see https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-payload-encodings.html
//
// `isBase64Encoded` is always set: ALB requires it ("The response from your
// Lambda function must include the Base64 encoding status, status code, and
// headers"), and API Gateway accepts an explicit `false` just the same.
// https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html#respond-to-load-balancer
export async function awsResponseBody(
  response: Response,
): Promise<{ body: string; isBase64Encoded: boolean }> {
  if (!response.body) {
    return { body: "", isBase64Encoded: false };
  }
  const buffer = await toBuffer(response.body as any);
  const contentType = response.headers.get("content-type") || "";
  return isTextType(contentType)
    ? { body: buffer.toString("utf8"), isBase64Encoded: false }
    : { body: buffer.toString("base64"), isBase64Encoded: true };
}

// Streaming response (uses awslambda global from Lambda runtime)
// https://docs.aws.amazon.com/lambda/latest/dg/response-streaming.html
export async function awsStreamResponse(
  response: Response,
  responseStream: AWSLambdaResponseStream,
  event?: AWSEvent,
): Promise<void> {
  const metadata: AWSLambdaStreamResponseMetadata = {
    statusCode: response.status,
    ...awsResponseHeaders(response, event),
  };

  // `response.body` does not say whether any bytes follow — `new Response("")`
  // has a body that yields none — and the prelude headers are frozen by the
  // first write, so the first chunk is pulled before they are assembled. This
  // costs no latency: the runtime only flushes the prelude on that write.
  const reader = response.body?.getReader();

  let writer: NodeJS.WritableStream | undefined;
  const startWriter = (hasBody: boolean): NodeJS.WritableStream => {
    if (hasBody && !isBodylessStatus(response.status)) {
      // ALB multi-value events yield `multiValueHeaders` only. ALB cannot
      // stream, but a misrouted event should still not crash here.
      if (metadata.headers) {
        metadata.headers["transfer-encoding"] ||= "chunked";
      } else if (metadata.multiValueHeaders) {
        metadata.multiValueHeaders["transfer-encoding"] ||= ["chunked"];
      }
    }
    // awslambda is a global provided by Lambda runtime
    writer = (globalThis as any).awslambda.HttpResponseStream.from(responseStream, metadata);
    return writer!;
  };

  try {
    const first = await readFirstChunk(reader);
    if (first.done) {
      // Nothing to chunk. The prelude is only flushed by a write, so write once
      // anyway: a zero-length write emits nothing on the wire.
      startWriter(false).write("");
      return;
    }
    await streamToNodeStream(reader!, startWriter(true), first);
  } finally {
    // A body that errored before the first chunk never started a writer, and an
    // unclosed response stream hangs the invocation until the Lambda timeout.
    (writer ?? startWriter(false)).end();
  }
}

// Statuses defined to carry no body, whatever the handler attached.
function isBodylessStatus(status: number): boolean {
  return status < 200 || status === 204 || status === 205 || status === 304;
}

// Exactly one chunk deep: an empty first chunk is a handler flushing its
// headers early, so it still counts as a body and must start the response.
async function readFirstChunk(
  reader?: ReadableStreamDefaultReader<any>,
): Promise<ReadableStreamReadResult<any>> {
  if (!reader) {
    return { done: true, value: undefined };
  }
  try {
    return await reader.read();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}

async function streamToNodeStream(
  reader: ReadableStreamDefaultReader<any>,
  writer: NodeJS.WritableStream,
  first: ReadableStreamReadResult<any>,
): Promise<void> {
  try {
    let result = first;
    while (!result.done) {
      const canContinue = writer.write(result.value);
      if (!canContinue) {
        await waitForDrain(writer);
      }
      result = await reader.read();
    }
  } catch (error) {
    // The writer is gone, so tell the source (a proxied `fetch`, a database
    // cursor, a file handle) to stop rather than leaving it producing into a
    // stream nobody will read. Releasing the lock alone does not signal it.
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// `drain` is only emitted by a live stream: if the response stream is torn down
// while buffered above its high-water mark (client disconnect, socket reset), it
// never fires. Awaiting it alone would leave the invocation pending until the
// Lambda timeout — billing wall-clock and holding a concurrency slot — so
// `error`/`close` settle the wait too.
function waitForDrain(writer: NodeJS.WritableStream): Promise<void> {
  const closedError = () => new Error("Response stream closed before it could drain");
  const stream = writer as NodeJS.WritableStream & {
    destroyed?: boolean;
    writableEnded?: boolean;
    errored?: Error | null;
  };
  if (stream.destroyed || stream.writableEnded) {
    // Already gone: `close` has fired and will not fire again. Prefer the
    // stream's own error, which says *why* it went away.
    return Promise.reject(stream.errored ?? closedError());
  }
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      writer.removeListener("drain", onDrain);
      writer.removeListener("error", onError);
      writer.removeListener("close", onClose);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onDrain = () => settle();
    const onError = (error: Error) => settle(error);
    const onClose = () => settle(closedError());
    writer.once("drain", onDrain);
    writer.once("error", onError);
    writer.once("close", onClose);
  });
}

// The parameters are split off before matching: testing the raw header value
// let the charset alternative match inside a parameter, so
// `application/octet-stream; charset=utf-8` (or a `multipart/form-data`
// boundary that merely contains `utf8`) was decoded with `toString("utf8")` and
// every invalid byte became U+FFFD — unrecoverable corruption. Structured
// syntax suffixes are matched too, since `/xml` and `/json` never match the
// `+xml`/`+json` forms, which left `image/svg+xml`, `application/xhtml+xml` and
// `application/ld+json` base64-inflated by ~33% for no reason.
function isTextType(contentType = "") {
  const mimeType = contentType.split(";")[0].trim();
  return /^text\/|\/(javascript|json|xml)|\+(json|xml)$/i.test(mimeType);
}

function toBuffer(data: ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    data
      .pipeTo(
        new WritableStream({
          write(chunk) {
            chunks.push(chunk);
          },
          close() {
            resolve(Buffer.concat(chunks));
          },
          abort(reason) {
            reject(reason);
          },
        }),
      )
      .catch(reject);
  });
}

// The gateway has already lossily parsed the query into `queryStringParameters`
// (v1/ALB only; v2 carries `rawQueryString`), so the raw string cannot be
// reconstructed exactly. `URLSearchParams` alone makes it worse though: it has
// no way to express a valueless param, so `?foo` round-trips as `?foo=`. That
// is invisible to anything re-parsing the query but not to route rules, cache
// keys, canonical URLs or a signature computed over `request.url`, so a bare key
// is emitted for empty values instead.
//
// `encoded` is for params that are still percent-encoded as on the wire (ALB),
// which are joined verbatim instead of being encoded a second time.
function stringifyQuery(obj: Record<string, unknown>, encoded?: boolean) {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      const str = item == null ? "" : String(item);
      // Decoded params go through `URLSearchParams` to keep escaping identical;
      // raw (ALB) ones are joined as-is.
      const pair = encoded
        ? `${escapeRawQuery(key)}=${escapeRawQuery(str)}`
        : new URLSearchParams([[key, str]]).toString();
      // An empty value yields `key=`; drop the `=` for a valueless param —
      // unless the key is empty too (`"="`), where dropping it would erase the
      // param.
      const bare = str === "" && key !== "";
      parts.push(bare ? pair.slice(0, -1) : pair);
    }
  }
  return parts.join("&");
}

// A raw query component is appended after `?` and parsed by `new URL`, where
// only `#` can end the query early (it starts the fragment, silently dropping
// the rest of the query). A request-target never carries a literal `#`, so this
// is purely defensive and costs nothing for real traffic.
function escapeRawQuery(value: string): string {
  return value.includes("#") ? value.replace(/#/g, "%23") : value;
}

// Reverse: Web Request => AWS Event (v1/v2 compatible)

export type AwsLambdaEvent = AWSLambdaProxyEvent & AWSLambdaProxyEventV2;

export async function requestToAwsEvent(request: Request): Promise<AwsLambdaEvent> {
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === "cookie") {
      // Payload 2.0 exposes one entry per cookie, not the raw header value.
      cookies.push(...splitCookieHeader(value));
    }
    headers[key] = value;
  }

  let body: string | undefined;
  let isBase64Encoded = false;
  if (request.body) {
    const buffer = await toBuffer(request.body as ReadableStream);
    const contentType = request.headers.get("content-type") || "";
    if (isTextType(contentType)) {
      body = buffer.toString("utf8");
    } else {
      body = buffer.toString("base64");
      isBase64Encoded = true;
    }
  }

  const now = Date.now();

  // Return a merged object compatible with both v1 and v2
  return {
    // v1 (REST API) fields
    httpMethod: request.method,
    path: url.pathname,
    resource: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    multiValueQueryStringParameters: parseMultiValueQuery(url.searchParams),
    pathParameters: undefined,
    stageVariables: undefined,
    multiValueHeaders: Object.fromEntries([...request.headers].map(([k, v]) => [k, [v]])),

    // v2 (HTTP API) fields
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    cookies: cookies.length > 0 ? cookies : undefined,
    routeKey: `${request.method} ${url.pathname}`,

    // Shared fields
    headers,
    body: body ?? null,
    isBase64Encoded,
    requestContext: {
      // v1 fields
      accountId: "000000000000",
      apiId: "local",
      resourceId: "local",
      stage: "$default",
      requestId: crypto.randomUUID(),
      identity: {
        sourceIp: "127.0.0.1",
        userAgent: request.headers.get("user-agent") || "",
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      resourcePath: url.pathname,
      httpMethod: request.method,
      path: url.pathname,
      protocol: "HTTP/1.1",
      requestTimeEpoch: now,
      authorizer: undefined,
      domainName: url.hostname,

      // v2 fields
      http: {
        method: request.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: request.headers.get("user-agent") || "",
      },
      routeKey: `${request.method} ${url.pathname}`,
      time: new Date(now).toISOString(),
      timeEpoch: now,
      domainPrefix: url.hostname.split(".")[0],
    },
  } as unknown as AwsLambdaEvent;
}

function splitCookieHeader(value: string): string[] {
  return value
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);
}

function parseMultiValueQuery(params: URLSearchParams): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of params) {
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(value);
  }
  return result;
}

// Reverse: AWS Result => Web Response

export type AwsLambdaResult = AWSLambdaProxyResult | AWSLambdaProxyResultV2;

export function awsResultToResponse(result: AwsLambdaResult): Response {
  // APIGatewayProxyResultV2 can be a plain string for simple responses
  if (typeof result === "string") {
    return new Response(result, { status: 200 });
  }

  const headers = new Headers();

  // Handle headers (both v1 and v2)
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) {
        headers.set(key, String(value));
      }
    }
  }

  // Handle multiValueHeaders (v1)
  if ("multiValueHeaders" in result && result.multiValueHeaders) {
    for (const [key, values] of Object.entries(result.multiValueHeaders)) {
      if (values) {
        for (const value of values) {
          headers.append(key, String(value));
        }
      }
    }
  }

  // Handle cookies (v2)
  if ("cookies" in result && result.cookies) {
    for (const cookie of result.cookies) {
      headers.append("set-cookie", cookie);
    }
  }

  // Handle body
  let body: ResponseBody | undefined;
  if (typeof result.body === "string") {
    if (result.isBase64Encoded) {
      body = Buffer.from(result.body, "base64");
    } else {
      body = result.body;
    }
  }

  const statusCode = typeof result.statusCode === "number" ? result.statusCode : 200;

  return new Response(body, {
    status: statusCode,
    headers,
  });
}

export function createMockContext(): AWSLambdaContext {
  const id = crypto.randomUUID();
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: "local",
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:us-east-1:000000000000:function:local`,
    memoryLimitInMB: "128",
    awsRequestId: id,
    logGroupName: "/aws/lambda/local",
    logStreamName: `${new Date().toISOString().split("T")[0]}/[$LATEST]${id}`,
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}
