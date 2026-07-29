import type * as AWS from "aws-lambda";

declare module "./core.mjs" {
  interface RuntimeTypes {
    "aws-lambda.context": {
      context: AWS.Context;
      event: AwsLambdaEvent;
    };
  }
}

export type AwsLambdaEvent = AWS.APIGatewayProxyEvent | AWS.APIGatewayProxyEventV2;
