import type { AWSLambdaFetchHandler, Server, ServerOptions } from "../types.ts";
import { wrapFetch } from "../_middleware.ts";
import { errorPlugin } from "../_plugins.ts";
import {
  awsRequest,
  awsResponseBody,
  awsResponseHeaders,
} from "./_aws/_utils.ts";

export function toLambdaHandler(options: ServerOptions): AWSLambdaFetchHandler {
  const server = new AWSLambdaServer(options);
  return (event, context) => server.fetch(event, context);
}

class AWSLambdaServer implements Server<AWSLambdaFetchHandler> {
  readonly runtime = "aws-lambda";
  readonly options: Server["options"];
  readonly fetch: AWSLambdaFetchHandler;

  constructor(options: ServerOptions) {
    this.options = { ...options, middleware: [...(options.middleware || [])] };

    for (const plugin of options.plugins || []) plugin(this as any as Server);
    errorPlugin(this as unknown as Server);

    const fetchHandler = wrapFetch(this as unknown as Server);

    this.fetch = async (event) => {
      const request = awsRequest(event);
      const response = await fetchHandler(request);

      return {
        statusCode: response.status,
        ...awsResponseHeaders(response),
        ...(await awsResponseBody(response)),
      };
    };
  }

  serve() {}

  ready(): Promise<Server<AWSLambdaFetchHandler>> {
    return Promise.resolve().then(() => this);
  }

  close() {
    return Promise.resolve();
  }
}
