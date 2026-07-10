import { handleLambdaEventWithStream, type AWSLambdaStreamingHandler } from "srvx/aws-lambda";

// The `awslambda` global is injected by the Lambda Node.js runtime and is
// only present when the function is invoked via `InvokeWithResponseStream`
// (Function URLs with `--invoke-mode RESPONSE_STREAM`, or an API Gateway
// REST API integration configured with `response.transferMode: STREAM`).
declare const awslambda: {
  streamifyResponse: <T extends (...args: any[]) => any>(handler: T) => T;
};

const fetchHandler = async (request: Request) => {
  const encoder = new TextEncoder();
  let counter = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const interval = setInterval(() => {
        counter++;
        controller.enqueue(encoder.encode(`chunk ${counter} at ${new Date().toISOString()}\n`));
        if (counter >= 5) {
          clearInterval(interval);
          controller.close();
        }
      }, 500);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

// Exported and wired up in `serverless.yml` behind a REST API (v1) `http`
// event with `response.transferMode: STREAM`, to prove that srvx's AWS
// Lambda streaming adapter also works through API Gateway REST APIs and
// not just Lambda Function URLs. See https://github.com/h3js/srvx/issues/184
export const streamHandler: AWSLambdaStreamingHandler = awslambda.streamifyResponse(
  (event, responseStream, context) =>
    handleLambdaEventWithStream(fetchHandler, event, responseStream, context),
);
