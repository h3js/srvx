import type { ServerRequest } from "../../types.ts";
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
): ServerRequest {
  const req = new Request(awsEventURL(event), {
    method: awsEventMethod(event),
    headers: awsEventHeaders(event),
    body: awsEventBody(event),
  }) as ServerRequest;

  req.runtime = {
    name: "aws-lambda",
    awsLambda: { event, context },
  };

  req.ip = awsEventIP(event);

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

function awsEventURL(event: APIGatewayProxyEvent | APIGatewayProxyEventV2): URL {
  const hostname =
    event.headers.host || event.headers.Host || event.requestContext?.domainName || ".";

  const path = (event as APIGatewayProxyEvent).path || (event as APIGatewayProxyEventV2).rawPath;

  const query = awsEventQuery(event);

  const protocol =
    (event.headers["X-Forwarded-Proto"] || event.headers["x-forwarded-proto"]) === "http"
      ? "http"
      : "https";

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
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) {
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
  const headers = Object.create(null);
  for (const [key, value] of response.headers) {
    if (value) {
      headers[key] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }

  const cookies = response.headers.getSetCookie();

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
  return isTextType(contentType)
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
  const writer = (globalThis as any).awslambda.HttpResponseStream.from(
    responseStream,
    metadata,
  );

  if (!response.body) {
    writer.end();
    return;
  }

  try {
    await streamToNodeStream(response.body, writer);
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
  const cookies: string[] = [];
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === "cookie") {
      cookies.push(value);
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

  return new Response(body, {
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
