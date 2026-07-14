import type { ServerRequest } from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { isTrustedProxy, firstForwardedValue } from "../../_trust-proxy.ts";
import type {
  APIGatewayProxyEvent,
  Context as AWSContext,
  APIGatewayProxyEventV2,
} from "aws-lambda";

// -- Streaming types --

export interface AWSLambdaStreamResponseMetadata {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
}

export type AWSLambdaResponseStream = NodeJS.WritableStream & {
  setContentType(contentType: string): void;
};

// -- Incoming/Outgoing types --

export interface AWSResponseHeaders {
  headers: Record<string, string>;
  cookies?: string[];
  multiValueHeaders?: Record<string, string[]>;
}

// Incoming (AWS => Web)

export function awsRequest(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  context: AWSContext,
  trustProxy?: TrustProxyOption,
): ServerRequest {
  // Real API Gateway always sends a `headers` object; a null/non-object here
  // means a malformed/hand-built event and would otherwise surface as an opaque
  // `TypeError` deep inside header parsing.
  if (!event.headers || typeof event.headers !== "object") {
    throw new TypeError("[srvx] Invalid AWS Lambda event: `headers` must be an object.");
  }

  // Resolve the immediate-peer address and trust decision once and pass them
  // down; both the URL and the client IP derivation need them.
  const sourceIp = awsEventIP(event);
  const trusted = isTrustedProxy(trustProxy, sourceIp);

  // Per the fetch spec a GET/HEAD request cannot carry a body; passing one to
  // `new Request` throws. Raw bytes stay reachable via `runtime.awsLambda.event`.
  const method = awsEventMethod(event);
  const hasBody = method !== "GET" && method !== "HEAD";

  const req = new Request(awsEventURL(event, trusted), {
    method,
    headers: awsEventHeaders(event),
    body: hasBody ? awsEventBody(event) : undefined,
  }) as ServerRequest;

  req.runtime = {
    name: "aws-lambda",
    awsLambda: { event, context },
  };

  req.ip = awsEventClientIP(event, sourceIp, trusted);

  return req;
}

function awsEventMethod(event: APIGatewayProxyEvent | APIGatewayProxyEventV2): string {
  return (
    (event as APIGatewayProxyEvent).httpMethod ||
    (event as APIGatewayProxyEventV2).requestContext?.http?.method ||
    "GET"
  );
}

function awsEventIP(event: APIGatewayProxyEvent | APIGatewayProxyEventV2): string | undefined {
  return (
    (event as APIGatewayProxyEventV2).requestContext?.http?.sourceIp || // v2 (HTTP API)
    (event as APIGatewayProxyEvent).requestContext?.identity?.sourceIp // v1 (REST API)
  );
}

/**
 * Resolve the client IP, preferring the leftmost `X-Forwarded-For` entry when
 * the immediate peer (the gateway `sourceIp`) is a trusted proxy.
 */
function awsEventClientIP(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  sourceIp: string | undefined,
  trusted: boolean,
): string | undefined {
  if (trusted) {
    const forwarded = firstForwardedValue(
      event.headers["X-Forwarded-For"] || event.headers["x-forwarded-for"],
    );
    if (forwarded) {
      return forwarded;
    }
  }
  return sourceIp;
}

function awsEventURL(event: APIGatewayProxyEvent | APIGatewayProxyEventV2, trusted: boolean): URL {
  const path = (event as APIGatewayProxyEvent).path || (event as APIGatewayProxyEventV2).rawPath;

  const query = awsEventQuery(event);

  // Only honor client-supplied `X-Forwarded-*` headers when the proxy is
  // trusted; otherwise any client could spoof the host or protocol.
  const forwardedHost = trusted
    ? firstForwardedValue(event.headers["X-Forwarded-Host"] || event.headers["x-forwarded-host"])
    : undefined;
  const hostname =
    forwardedHost ||
    event.headers.host ||
    event.headers.Host ||
    event.requestContext?.domainName ||
    ".";

  // Assume `https` when untrusted (Lambda is always TLS-terminated at the gateway).
  const forwardedProto = trusted
    ? firstForwardedValue(event.headers["X-Forwarded-Proto"] || event.headers["x-forwarded-proto"])
    : undefined;
  const protocol = forwardedProto === "http" ? "http" : "https";

  return new URL(`${path}${query ? `?${query}` : ""}`, `${protocol}://${hostname}`);
}

function awsEventQuery(event: APIGatewayProxyEvent | APIGatewayProxyEventV2) {
  if (typeof (event as APIGatewayProxyEventV2).rawQueryString === "string") {
    return (event as APIGatewayProxyEventV2).rawQueryString;
  }
  const queryObj = {
    ...event.queryStringParameters,
    ...(event as APIGatewayProxyEvent).multiValueQueryStringParameters,
  };
  return stringifyQuery(queryObj);
}

function awsEventHeaders(event: APIGatewayProxyEvent | APIGatewayProxyEventV2): Headers {
  const headers = new Headers();

  // v1 (REST API) events carry repeated headers in `multiValueHeaders`; the
  // single-valued `headers` map only keeps the last value for each key. Prefer
  // the multi-value form and skip those keys in the single map to avoid
  // duplicating a header that appears in both.
  const multiValueHeaders = (event as APIGatewayProxyEvent).multiValueHeaders;
  const covered = new Set<string>();
  if (multiValueHeaders) {
    for (const [key, values] of Object.entries(multiValueHeaders)) {
      if (!values) continue;
      covered.add(key.toLowerCase());
      for (const value of values) {
        if (value != null) {
          headers.append(key, value);
        }
      }
    }
  }

  for (const [key, value] of Object.entries(event.headers)) {
    if (value && !covered.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  if ("cookies" in event && event.cookies) {
    for (const cookie of event.cookies) {
      headers.append("cookie", cookie);
    }
  }
  return headers;
}

export function awsEventBody(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): BodyInit | undefined {
  if (!event.body) {
    return undefined;
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body || "", "base64");
  }
  return event.body;
}

// Outgoing (Web => AWS)

export function awsResponseHeaders(
  response: Response,
  event?: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): AWSResponseHeaders {
  const cookies = response.headers.getSetCookie();

  const headers = Object.create(null);
  for (const [key, value] of response.headers) {
    // `set-cookie` is delivered via `cookies` (v2) / `multiValueHeaders` (v1).
    // Emitting it here too makes API Gateway merge both and send the last
    // cookie a second time.
    if (key === "set-cookie") continue;
    if (value) {
      headers[key] = value;
    }
  }

  if (cookies.length === 0) {
    return { headers };
  }

  const isV2 =
    (event as APIGatewayProxyEventV2)?.version === "2.0" ||
    !!(event as APIGatewayProxyEventV2)?.requestContext?.http;

  return isV2
    ? { headers, cookies }
    : { headers, cookies, multiValueHeaders: { "set-cookie": cookies } };
}

// AWS Lambda proxy integrations requires base64 encoded buffers
// binaryMediaTypes should be */*
// see https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-payload-encodings.html
export async function awsResponseBody(
  response: Response,
): Promise<{ body: string; isBase64Encoded?: boolean }> {
  if (!response.body) {
    return { body: "" };
  }
  const buffer = await toBuffer(response.body as any);
  const contentType = response.headers.get("content-type") || "";
  // A compressed body (e.g. `content-encoding: gzip`) is binary regardless of
  // its content-type; running it through `toString("utf8")` mangles the bytes.
  const contentEncoding = (response.headers.get("content-encoding") || "").trim().toLowerCase();
  const isEncoded = contentEncoding !== "" && contentEncoding !== "identity";
  return !isEncoded && isTextType(contentType)
    ? { body: buffer.toString("utf8") }
    : { body: buffer.toString("base64"), isBase64Encoded: true };
}

// Streaming response (uses awslambda global from Lambda runtime)
// https://docs.aws.amazon.com/lambda/latest/dg/response-streaming.html
export async function awsStreamResponse(
  response: Response,
  responseStream: AWSLambdaResponseStream,
  event?: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Promise<void> {
  const metadata: AWSLambdaStreamResponseMetadata = {
    statusCode: response.status,
    ...awsResponseHeaders(response, event),
  };

  if (!metadata.headers!["transfer-encoding"]) {
    metadata.headers!["transfer-encoding"] = "chunked";
  }

  // awslambda is a global provided by Lambda runtime
  const writer = (globalThis as any).awslambda.HttpResponseStream.from(responseStream, metadata);
  const body =
    response.body ??
    new ReadableStream<string>({
      start(controller) {
        controller.enqueue("");
        controller.close();
      },
    });

  try {
    await streamToNodeStream(body, writer);
  } finally {
    writer.end();
  }
}

async function streamToNodeStream(
  body: ReadableStream,
  writer: NodeJS.WritableStream,
): Promise<void> {
  const reader = body.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      const canContinue = writer.write(result.value);
      if (!canContinue) {
        await new Promise<void>((resolve) => writer.once("drain", resolve));
      }
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

function isTextType(contentType = "") {
  return /^text\/|\/(javascript|json|xml)|utf-?8/i.test(contentType);
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

function stringifyQuery(obj: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        params.append(key, String(v));
      }
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

// Reverse: Web Request => AWS Event (v1/v2 compatible)

export type AwsLambdaEvent = APIGatewayProxyEvent & APIGatewayProxyEventV2;

export async function requestToAwsEvent(request: Request): Promise<AwsLambdaEvent> {
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  const cookies: string[] = [];
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === "cookie") {
      // Real v2 API Gateway events strip `cookie` from `headers` and carry it in
      // `cookies`; keeping it in the header maps too would double it once
      // `awsEventHeaders` re-appends `event.cookies` on the round trip.
      cookies.push(value);
      continue;
    }
    headers[key] = value;
    (multiValueHeaders[key] ??= []).push(value);
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
    multiValueHeaders,

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

export type AwsLambdaResult =
  | import("aws-lambda").APIGatewayProxyResult
  | import("aws-lambda").APIGatewayProxyResultV2;

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
  let body: BodyInit | undefined;
  if (typeof result.body === "string") {
    if (result.isBase64Encoded) {
      body = Buffer.from(result.body, "base64");
    } else {
      body = result.body;
    }
  }

  const statusCode = typeof result.statusCode === "number" ? result.statusCode : 200;

  // `new Response(body, ...)` throws for null-body statuses when `body` is a
  // (even empty) string, which broke the documented local-testing round trip
  // for any 204/304 handler.
  const nullBody =
    statusCode === 101 || statusCode === 204 || statusCode === 205 || statusCode === 304;

  return new Response(nullBody ? null : body, {
    status: statusCode,
    headers,
  });
}

export function createMockContext(): AWSContext {
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
