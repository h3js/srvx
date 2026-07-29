import type { FetchHandler, Server, ServerOptions } from "../types.ts";
import type {
  AWSLambdaContext,
  AWSLambdaProxyEvent,
  AWSLambdaProxyEventV2,
  AWSLambdaProxyResult,
  AWSLambdaProxyResultV2,
} from "../types/aws-lambda.ts";
import type { TrustProxyOption } from "../_trust-proxy.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";
import {
  awsRequest,
  awsResponseBody,
  awsResponseHeaders,
  awsStreamResponse,
  requestToAwsEvent,
  awsResultToResponse,
  createMockContext,
  type AWSLambdaResponseStream,
} from "./_aws/utils.ts";

type MaybePromise<T> = T | Promise<T>;

export type AwsLambdaEvent = AWSLambdaProxyEvent | AWSLambdaProxyEventV2;

export type { AWSLambdaResponseStream };

export type AWSLambdaHandler = (
  event: AwsLambdaEvent,
  context: AWSLambdaContext,
) => MaybePromise<AWSLambdaProxyResult | AWSLambdaProxyResultV2>;

export type AWSLambdaStreamingHandler = (
  event: AwsLambdaEvent,
  responseStream: AWSLambdaResponseStream,
  context: AWSLambdaContext,
) => MaybePromise<void>;

export function toLambdaHandler(options: ServerOptions): AWSLambdaHandler {
  const server = new AWSLambdaServer(options);
  return (event, context) => server.fetch(event, context);
}

export async function handleLambdaEvent(
  fetchHandler: FetchHandler,
  event: AwsLambdaEvent,
  context: AWSLambdaContext,
  trustProxy?: TrustProxyOption,
): Promise<AWSLambdaProxyResult | AWSLambdaProxyResultV2> {
  const request = awsRequest(event, context, trustProxy);
  const response = await fetchHandler(request);
  return {
    statusCode: response.status,
    ...awsResponseHeaders(response, event),
    ...(await awsResponseBody(response)),
  };
}

export async function handleLambdaEventWithStream(
  fetchHandler: FetchHandler,
  event: AwsLambdaEvent,
  responseStream: AWSLambdaResponseStream,
  context: AWSLambdaContext,
  trustProxy?: TrustProxyOption,
): Promise<void> {
  const request = awsRequest(event, context, trustProxy);
  const response = await fetchHandler(request);
  await awsStreamResponse(response, responseStream, event);
}

export async function invokeLambdaHandler(
  handler: AWSLambdaHandler,
  request: Request,
): Promise<Response> {
  const event = await requestToAwsEvent(request);
  const result = await handler(event, createMockContext());
  return awsResultToResponse(result);
}

class AWSLambdaServer implements Server<AWSLambdaHandler> {
  readonly runtime = "aws-lambda";
  readonly options: Server["options"];
  readonly fetch: AWSLambdaHandler;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this as any as Server);
    errorPlugin(this as unknown as Server);

    const fetchHandler = wrapFetch(this as unknown as Server);

    this.fetch = (event: AwsLambdaEvent, context: AWSLambdaContext) =>
      handleLambdaEvent(fetchHandler, event, context, this.options.trustProxy);
  }

  serve() {}

  ready(): Promise<Server<AWSLambdaHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    return Promise.resolve();
  }
}
