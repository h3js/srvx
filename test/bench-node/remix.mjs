import * as http from "node:http";
import { createRequestListener } from "@mjackson/node-fetch-server";
import { fetchHandler } from "./_handler.mjs";

let server = http.createServer(createRequestListener(fetchHandler));

server.listen(3000);
