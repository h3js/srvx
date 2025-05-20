import { createServer } from "node:http";
import { createServerAdapter } from "@whatwg-node/server";

const nodeServer = createServer(
  createServerAdapter((_req) => {
    return new Response("Hello!");
  }),
);

nodeServer.listen(3000);
