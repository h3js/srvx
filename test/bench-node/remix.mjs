import * as http from "node:http";
import { createRequestListener } from "@mjackson/node-fetch-server";

let server = http.createServer(
  createRequestListener((req) => {
    return new Response("Hello!", {
      headers: { "x-test": req.headers.get("x-test") },
    });
  }),
);

server.listen(3000);
