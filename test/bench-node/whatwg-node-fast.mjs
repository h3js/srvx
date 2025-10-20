import { createServer } from "node:http";
import { createServerAdapter, Response } from "@whatwg-node/server";

const nodeServer = createServer(
  createServerAdapter((req) => {
    return new Response("Hello!", {
      headers: { "x-test": req.headers.get("x-test") },
    });
  }),
);

nodeServer.listen(3000);
