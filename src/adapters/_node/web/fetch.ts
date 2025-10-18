import type {
  ServerRequest,
  NodeHttpHandler,
  FetchHandler,
} from "../../../types.ts";

import { WebIncomingMessage } from "./incoming.ts";
import { WebRequestSocket } from "./socket.ts";
import { callNodeHandler } from "../call.ts";
import { WebServerResponse } from "./response.ts";

// https://github.com/nodejs/node/blob/main/lib/_http_incoming.js
// https://github.com/nodejs/node/blob/main/lib/_http_outgoing.js
// https://github.com/nodejs/node/blob/main/lib/_http_server.js

/**
 * Calls a Node.js HTTP Request handler with a Fetch API Request object and returns a Response object.
 *
 * If the web Request contains an existing Node.js req/res pair (indicating it originated from a Node.js server from srvx/node), it will be called directly.
 *
 * Otherwise, new Node.js IncomingMessage and ServerResponse objects are created and linked to a custom Duplex stream that bridges the Fetch API streams with Node.js streams.
 *
 * The handler is invoked with these objects, and the response is constructed from the ServerResponse once it is finished.
 *
 * @experimental Behavior might be unstable.
 */
export async function fetchNodeHandler(
  handler: NodeHttpHandler,
  req: ServerRequest,
): Promise<Response> {
  // Direct pass through if coming from a Node server handler
  const nodeRuntime = req.runtime?.node;
  if (nodeRuntime && nodeRuntime.req && nodeRuntime.res) {
    const webRes = await callNodeHandler(handler, req);
    return webRes;
  }

  // Create Node req/res objects
  const socket = new WebRequestSocket(req);
  const nodeReq = new WebIncomingMessage(req, socket);
  const nodeRes = new WebServerResponse(nodeReq, socket);

  try {
    await handler(nodeReq, nodeRes);
    return await nodeRes.toWebResponse();
  } catch (error) {
    console.error(error, { cause: { req, handler } });
    return new Response(null, {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
}

/**
 * Converts a Node.js HTTP handler into a Fetch API handler.
 *
 * @experimental Behavior might be unstable.
 */
export function toWebHandler(
  handler: NodeHttpHandler | FetchHandler,
): FetchHandler {
  if (handler.length === 1) {
    return handler as FetchHandler;
  }
  return (req: ServerRequest) =>
    fetchNodeHandler(handler as NodeHttpHandler, req);
}
