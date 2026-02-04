import type * as AWS from "aws-lambda";
import type { FetchHandler, Server, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";
import { awsRequest, awsResponseBody, awsResponseHeaders } from "./_aws/_utils.ts";

type MaybePromise<T> = T | Promise<T>;

export type AwsLambdaEvent = AWS.APIGatewayProxyEvent | AWS.APIGatewayProxyEventV2;

export type AWSLambdaHandler = (
  event: AwsLambdaEvent,
  ctx: AWS.Context,
) => MaybePromise<AWS.APIGatewayProxyResult | AWS.APIGatewayProxyResultV2>;

export function toLambdaHandler(options: ServerOptions): AWSLambdaHandler {
  const server = new AWSLambdaServer(options);
  return (event, ctx) => server.fetch(event, ctx);
}

export async function handleLambdaEvent(
  fetchHandler: FetchHandler,
  event: AwsLambdaEvent,
  _ctx: AWS.Context,
): Promise<AWS.APIGatewayProxyResult | AWS.APIGatewayProxyResultV2> {
  const request = awsRequest(event);
  const response = await fetchHandler(request);
  return {
    statusCode: response.status,
    ...awsResponseHeaders(response),
    ...(await awsResponseBody(response)),
  };
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

    this.fetch = (event: AwsLambdaEvent, ctx: AWS.Context) =>
      handleLambdaEvent(fetchHandler, event, ctx);
  }

  serve() {}

  ready(): Promise<Server<AWSLambdaHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    return Promise.resolve();
  }
}
