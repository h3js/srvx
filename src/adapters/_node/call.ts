import type {
  NodeHttpHandler,
  NodeHTTPMiddleware,
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";

import { NodeResponseHeaders } from "./headers.ts";
import { NodeResponse } from "./response.ts";

export function callNodeHandler(
  handler: NodeHttpHandler | NodeHTTPMiddleware,
  req: ServerRequest,
): Promise<Response> {
  const isMiddleware = handler.length > 2;

  const nodeCtx = req.runtime?.node as {
    req: NodeServerRequest;
    res: NodeServerResponse;
  };
  if (!nodeCtx || !nodeCtx.req || !nodeCtx.res) {
    throw new Error("Node.js runtime context is not available.");
  }
  const { req: nodeReq, res: nodeRes } = nodeCtx;

  let _headers: Headers | undefined;
  const webRes = new NodeResponse(undefined, {
    get status() {
      return nodeRes.statusCode;
    },
    get statusText() {
      return nodeRes.statusMessage;
    },
    get headers() {
      if (!_headers) {
        _headers = new (NodeResponseHeaders as typeof NodeResponseHeaders)(
          nodeCtx,
        );
      }
      return _headers;
    },
  });

  return new Promise((resolve, reject) => {
    nodeRes.once("close", () => resolve(webRes));
    nodeRes.once("finish", () => resolve(webRes));
    nodeRes.once("error", (error) => reject(error));

    let streamPromise: Promise<Response> | undefined;
    nodeRes.once("pipe", (stream) => {
      streamPromise = new Promise((resolve) => {
        stream.on("end", () => resolve(webRes));
        stream.on("error", (error) => reject(error));
      });
    });

    try {
      if (isMiddleware) {
        Promise.resolve(
          handler(nodeReq, nodeRes, (error) =>
            error ? reject(error) : streamPromise || resolve(webRes),
          ),
        ).catch((error) => reject(error));
      } else {
        Promise.resolve((handler as NodeHttpHandler)(nodeReq, nodeRes)).then(
          () => streamPromise || webRes,
        );
      }
    } catch (error: unknown) {
      reject(error);
    }
  });
}
