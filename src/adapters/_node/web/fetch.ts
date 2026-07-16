import type { ServerRequest, NodeHttpHandler } from "../../../types.ts";

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
 * The handler is invoked with these objects, and the response is constructed from the ServerResponse as soon as its head is available, with the body streaming as the handler writes it.
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

  const handlerPromise = (async () => handler(nodeReq as any, nodeRes as any))();

  // Once the head is out a 500 is no longer possible, so a late handler failure
  // can only be surfaced by tearing down the socket, which errors the body
  // stream the consumer is reading. Before the head, the race below turns the
  // same failure into a 500 and this is a no-op.
  handlerPromise.catch((error) => {
    if (nodeRes.headersSent) {
      logError(error, req, handler);
      socket.destroy(error);
    }
  });

  try {
    // Waiting for the handler to *finish* would hold the response back until the
    // body is complete: buffering large ones in full and never resolving for an
    // endless one (SSE). The head is enough to build the Response and stream the
    // rest. See https://github.com/h3js/srvx/issues/248
    await Promise.race([handlerPromise, nodeRes.waitForHead()]);
    return await nodeRes.toWebResponse();
  } catch (error: any) {
    logError(error, req, handler);
    return new Response(null, {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
}

function logError(error: any, req: ServerRequest, handler: NodeHttpHandler): void {
  // Client aborts / premature socket closes are routine (the client is already
  // gone), so don't log them as errors. See https://github.com/h3js/srvx/issues/208
  const aborted =
    req.signal?.aborted ||
    error?.name === "AbortError" ||
    error?.code === "ERR_STREAM_PREMATURE_CLOSE";
  if (!aborted) {
    console.error(error, { cause: { req, handler } });
  }
}
