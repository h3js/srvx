import type {
  FetchHandler,
  NodeHttpHandler,
  NodeHTTPMiddleware,
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { fetchNodeHandler } from "../node.ts";
import { NodeRequest } from "./request.ts";
import { handleSendError, sendErrorResponse, sendNodeResponse } from "./send.ts";

export type AdapterMeta = {
  __nodeHandler?: NodeHttpHandler;
  __fetchHandler?: FetchHandler;
};

/**
 * Converts a Fetch API handler to a Node.js HTTP handler.
 */
export function toNodeHandler(
  handler: FetchHandler & AdapterMeta,
  options?: { maxRequestBodySize?: number; trustProxy?: TrustProxyOption },
): NodeHttpHandler & AdapterMeta {
  if (handler.__nodeHandler) {
    return handler.__nodeHandler;
  }

  function convertedNodeHandler(nodeReq: NodeServerRequest, nodeRes: NodeServerResponse) {
    const request = new NodeRequest({
      req: nodeReq,
      res: nodeRes,
      maxRequestBodySize: options?.maxRequestBodySize,
      trustProxy: options?.trustProxy,
    });
    const res = handler(request);
    return typeof (res as Promise<Response>)?.then === "function"
      ? (res as Promise<Response>).then((resolvedRes) => send(nodeRes, resolvedRes))
      : send(nodeRes, res as Response);
  }

  (convertedNodeHandler as AdapterMeta).__fetchHandler = handler;
  assignFnName(convertedNodeHandler, handler, " (converted to Node handler)");

  return convertedNodeHandler;
}

/**
 * `sendNodeResponse` reports a serialization failure (e.g. an invalid status code
 * or header value in `writeHead`) by rejecting. The handler returned here is
 * normally mounted on `node:http`/connect, which ignores its return value, so
 * nothing would handle that rejection and the default
 * `--unhandled-rejections=throw` takes the process down (#290). Answer a bare 500
 * and keep serving instead, matching what `serve()` does on the same failure.
 */
function send(nodeRes: NodeServerResponse, webRes: Response): Promise<void> {
  return sendNodeResponse(nodeRes, webRes).catch((error) => handleSendError(nodeRes, error));
}

/**
 * Converts a Node.js HTTP handler into a Fetch API handler.
 *
 * @experimental Behavior might be unstable and won't work in Bun and Deno currently (tracker: https://github.com/h3js/srvx/issues/132)
 */
export function toFetchHandler(
  handler: (NodeHttpHandler | NodeHTTPMiddleware) & AdapterMeta,
): FetchHandler & AdapterMeta {
  if (handler.__fetchHandler) {
    return handler.__fetchHandler;
  }

  function convertedNodeHandler(req: ServerRequest): Promise<Response> {
    return fetchNodeHandler(handler, req);
  }

  // Without a caller's `next`, middleware gets one that answers `next()` and `next(err)` like `serve()`; what it throws reaches the caller.
  (convertedNodeHandler as AdapterMeta).__nodeHandler =
    handler.length === 3
      ? (
          nodeReq: NodeServerRequest,
          nodeRes: NodeServerResponse,
          next?: (error?: Error) => void,
        ) => {
          return (handler as NodeHTTPMiddleware)(
            nodeReq as any,
            nodeRes as any,
            next ||
              ((error) => {
                if (error) {
                  sendErrorResponse(nodeRes, error);
                } else {
                  nodeRes.end();
                }
              }),
          ) as void | Promise<void>;
        }
      : (handler as NodeHttpHandler);
  assignFnName(convertedNodeHandler, handler, " (converted to Web handler)");

  return convertedNodeHandler;
}

// --- utils ---

type Fn = (...args: any[]) => any;
function assignFnName(target: Fn, source: Fn, suffix: string) {
  if (source.name) {
    try {
      Object.defineProperty(target, "name", {
        value: `${source.name}${suffix}`,
      });
    } catch {
      /* safe to ignore */
    }
  }
}
