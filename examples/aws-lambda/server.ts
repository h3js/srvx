import { toLambdaHandler } from "srvx/aws-lambda";
import { serveStatic } from "srvx/static";

export const handler = toLambdaHandler({
  middleware: [serveStatic({ dir: "public" })],
  fetch(req: Request) {
    return Response.json({ hello: "world!" });
  },
});
