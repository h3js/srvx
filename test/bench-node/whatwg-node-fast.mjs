import { createServer } from "node:http";
import { createServerAdapter, Response as FastResponse } from "@whatwg-node/server";
import { fetchHandler } from "./_handler.mjs";

globalThis.Response = FastResponse;

const nodeServer = createServer(createServerAdapter(fetchHandler));

nodeServer.listen(3000);
