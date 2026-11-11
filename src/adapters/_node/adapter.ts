import type {
  FetchHandler,
  NodeHttpHandler,
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import type { TrustProxyOption } from "../../_trust-proxy.ts";
import { fetchNodeHandler } from "../node.ts";
import { NodeRequest } from "./request.ts";
import { handleSendError, sendNodeResponse } from "./send.ts";
import { hasBackslashInPath } from "./url.ts";
import { settleRequestBody } from "./body-limit.ts";

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
    // Unlike `serve()`, other request-target shapes are left to
    // `NodeRequestURL` here, but a raw `\` in the path would make the fetch
    // handler and the host server's routing disagree (see `hasBackslashInPath`).
    if (nodeReq.url && hasBackslashInPath(nodeReq.url)) {
      nodeRes.statusCode = 400;
      nodeRes.end();
      return;
    }
    const maxRequestBodySize = options?.maxRequestBodySize;
    const request = new NodeRequest({
      req: nodeReq,
      res: nodeRes,
      maxRequestBodySize,
      trustProxy: options?.trustProxy,
    });
    let res: Response | Promise<Response>;
    try {
      res = handler(request);
    } catch (error) {
      // The host server answers the error; the body still needs settling first.
      settleRequestBody(nodeReq, nodeRes, maxRequestBodySize, true);
      throw error;
    }
    if (typeof (res as Promise<Response>)?.then === "function") {
      return (res as Promise<Response>).then(
        (resolvedRes) => sendSettled(nodeReq, nodeRes, resolvedRes, maxRequestBodySize),
        (error) => {
          settleRequestBody(nodeReq, nodeRes, maxRequestBodySize, true);
          throw error;
        },
      );
    }
    return sendSettled(nodeReq, nodeRes, res as Response, maxRequestBodySize);
  }

  (convertedNodeHandler as AdapterMeta).__fetchHandler = handler;
  assignFnName(convertedNodeHandler, handler, " (converted to Node handler)");

  return convertedNodeHandler;
}

function sendSettled(
  nodeReq: NodeServerRequest,
  nodeRes: NodeServerResponse,
  webRes: Response,
  maxRequestBodySize: number | undefined,
): Promise<void> {
  const settled = settleRequestBody(nodeReq, nodeRes, maxRequestBodySize);
  return settled ? settled.then(() => send(nodeRes, webRes)) : send(nodeRes, webRes);
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
export function toFetchHandler(handler: NodeHttpHandler & AdapterMeta): FetchHandler & AdapterMeta {
  if (handler.__fetchHandler) {
    return handler.__fetchHandler;
  }

  function convertedNodeHandler(req: ServerRequest): Promise<Response> {
    return fetchNodeHandler(handler as NodeHttpHandler, req);
  }

  (convertedNodeHandler as AdapterMeta).__nodeHandler = handler as NodeHttpHandler;
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
