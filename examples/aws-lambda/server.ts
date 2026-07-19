import { toLambdaHandler } from "srvx/aws-lambda";
import { staticMiddleware } from "srvx/static";

export const handler = toLambdaHandler({
  middleware: [staticMiddleware({ dir: "public" })],
  fetch(req: Request) {
    return Response.json({ hello: "world!" });
  },
});
