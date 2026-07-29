// Minimal AWS Lambda types. See `src/types/README.md` for why these are inlined.

/**
 * AWS Lambda invocation context (`aws-lambda`'s `Context`).
 */
export interface AWSLambdaContext {
  callbackWaitsForEmptyEventLoop: boolean;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis(): number;
  done(error?: Error, result?: any): void;
  fail(error: Error | string): void;
  succeed(messageOrObject: any): void;
}

/**
 * API Gateway REST API (v1) proxy event (`APIGatewayProxyEvent`).
 */
export interface AWSLambdaProxyEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  multiValueHeaders?: Record<string, string[] | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body: string | null;
  isBase64Encoded: boolean;
  requestContext: {
    domainName?: string;
    identity?: { sourceIp?: string };
  };
}

/**
 * API Gateway HTTP API (v2) proxy event (`APIGatewayProxyEventV2`).
 */
export interface AWSLambdaProxyEventV2 {
  version: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: {
    domainName?: string;
    http?: {
      method: string;
      path?: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
  };
}

/**
 * API Gateway REST API (v1) proxy result (`APIGatewayProxyResult`).
 */
export interface AWSLambdaProxyResult {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  body: string;
  isBase64Encoded?: boolean;
}

/**
 * API Gateway HTTP API (v2) proxy result (`APIGatewayProxyResultV2`).
 */
export type AWSLambdaProxyResultV2 =
  | string
  | {
      statusCode?: number;
      headers?: Record<string, string | number | boolean>;
      body?: string;
      isBase64Encoded?: boolean;
      cookies?: string[];
    };
