import type {
  FetchHandler,
  NodeHttpHandler,
  NodeServerRequest,
  NodeServerResponse,
  ServerRequest,
} from "../../types.ts";
import { fetchNodeHandler } from "../node.ts";
import { NodeRequest } from "./request.ts";
import { sendNodeResponse } from "./send.ts";

export type AdapterMeta = {
  __nodeHandler?: NodeHttpHandler;
  __fetchHandler?: FetchHandler;
};

/**
 * Converts a Fetch API handler to a Node.js HTTP handler.
 */
export function toNodeHandler(handler: FetchHandler & AdapterMeta): NodeHttpHandler & AdapterMeta {
  if (handler.__nodeHandler) {
    return handler.__nodeHandler;
  }

  function convertedNodeHandler(nodeReq: NodeServerRequest, nodeRes: NodeServerResponse) {
    const request = new NodeRequest({ req: nodeReq, res: nodeRes });
    const res = handler(request);
    return res instanceof Promise
      ? res.then((resolvedRes) => sendNodeResponse(nodeRes, resolvedRes))
      : sendNodeResponse(nodeRes, res);
  }

  (convertedNodeHandler as AdapterMeta).__fetchHandler = handler;
  assignFnName(convertedNodeHandler, handler, " (converted to Node handler)");

  return convertedNodeHandler;
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
