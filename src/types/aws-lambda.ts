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
  identity?: any;
  clientContext?: any;
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
  resource?: string;
  headers: Record<string, string | undefined>;
  multiValueHeaders?: Record<string, string[] | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  stageVariables?: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded: boolean;
  requestContext: {
    accountId?: string;
    apiId?: string;
    authorizer?: any;
    domainName?: string;
    /** Present only on Application Load Balancer events. */
    elb?: { targetGroupArn?: string };
    httpMethod?: string;
    identity?: { sourceIp?: string };
    path?: string;
    protocol?: string;
    requestId?: string;
    requestTimeEpoch?: number;
    resourcePath?: string;
    stage?: string;
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
  pathParameters?: Record<string, string | undefined>;
  stageVariables?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: {
    accountId?: string;
    apiId?: string;
    authorizer?: any;
    domainName?: string;
    domainPrefix?: string;
    requestId?: string;
    routeKey?: string;
    stage?: string;
    time?: string;
    timeEpoch?: number;
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
