import { toLambdaHandler } from "srvx/aws-lambda";

export const handler = toLambdaHandler({
  fetch(req: Request) {
    return Response.json({ hello: "world!" });
  },
});
