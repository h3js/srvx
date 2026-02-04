import type * as AWS from "aws-lambda";
import type { FetchHandler, Server, ServerOptions } from "../types.ts";
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

export type AwsLambdaEvent = AWS.APIGatewayProxyEvent | AWS.APIGatewayProxyEventV2;

export type { AWSLambdaResponseStream };

export type AWSLambdaHandler = (
  event: AwsLambdaEvent,
  context: AWS.Context,
) => MaybePromise<AWS.APIGatewayProxyResult | AWS.APIGatewayProxyResultV2>;

export type AWSLambdaStreamingHandler = (
  event: AwsLambdaEvent,
  responseStream: AWSLambdaResponseStream,
  context: AWS.Context,
) => MaybePromise<void>;

export function toLambdaHandler(options: ServerOptions): AWSLambdaHandler {
  const server = new AWSLambdaServer(options);
  return (event, context) => server.fetch(event, context);
}

export async function handleLambdaEvent(
  fetchHandler: FetchHandler,
  event: AwsLambdaEvent,
  context: AWS.Context,
): Promise<AWS.APIGatewayProxyResult | AWS.APIGatewayProxyResultV2> {
  const request = awsRequest(event, context);
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
  context: AWS.Context,
): Promise<void> {
  const request = awsRequest(event, context);
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

    this.fetch = (event: AwsLambdaEvent, context: AWS.Context) =>
      handleLambdaEvent(fetchHandler, event, context);
  }

  serve() {}

  ready(): Promise<Server<AWSLambdaHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    return Promise.resolve();
  }
}
