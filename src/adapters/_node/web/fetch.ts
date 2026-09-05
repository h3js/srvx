import type { ServerRequest, NodeHttpHandler, NodeHTTPMiddleware } from "../../../types.ts";

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
    // Connect-style middleware `(req, res, next)` is invoked with a bridged
    // `next` so it can signal completion or forward an error. Mirrors the
    // arity-aware handling in `callNodeHandler` (used on the real-runtime path).
    // A plain `(req, res)` handler keeps its original 2-arg invocation.
    if (handler.length > 2) {
      await new Promise<void>((resolve, reject) => {
        nodeRes.once("finish", () => resolve());
        nodeRes.once("close", () => resolve());
        nodeRes.once("error", (error) => reject(error));
        Promise.resolve(
          (handler as NodeHTTPMiddleware)(nodeReq as any, nodeRes as any, (error) => {
            if (error) {
              return reject(error);
            }
            // `next()` with no downstream handler: finalize the response so
            // `toWebResponse()` can settle instead of waiting forever.
            if (!nodeRes.writableEnded) {
              nodeRes.end();
            }
            resolve();
          }),
        ).catch((error) => reject(error));
      });
    } else {
      await handler(nodeReq as any, nodeRes as any);
    }
    return await nodeRes.toWebResponse();
  } catch (error: any) {
    // Client aborts / premature socket closes are routine (the client is already
    // gone), so don't log them as errors. See https://github.com/h3js/srvx/issues/208
    const aborted =
      req.signal?.aborted ||
      error?.name === "AbortError" ||
      error?.code === "ERR_STREAM_PREMATURE_CLOSE";
    if (!aborted) {
      console.error(error, { cause: { req, handler } });
    }
    return new Response(null, {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
}
