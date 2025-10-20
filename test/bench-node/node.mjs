import { createServer } from "node:http";
import { nodeHandler } from "./_handler.mjs";

const server = createServer(nodeHandler);

server.listen(3000);
