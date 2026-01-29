import { createServer } from "node:http";
import { createServerAdapter } from "@whatwg-node/server";
import { fetchHandler } from "./_handler.mjs";

const nodeServer = createServer(createServerAdapter(fetchHandler));

nodeServer.listen(3000);
