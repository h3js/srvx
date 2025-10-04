import type { NodeServerRequest, NodeServerResponse } from "../../types.ts";
import { FastURL } from "../../_url.ts";

export class NodeRequestURL extends FastURL {
  constructor({ req }: { req: NodeServerRequest; res?: NodeServerResponse }) {
    const host =
      req.headers.host ||
      (req.headers[":authority"] as string) ||
      `${req.socket.localFamily === "IPv6" ? "[" + req.socket.localAddress + "]" : req.socket.localAddress}:${req.socket?.localPort || "80"}`;

    const protocol =
      (req.socket as any)?.encrypted ||
      req.headers["x-forwarded-proto"] === "https"
        ? "https:"
        : "http:";

    const qIndex = (req.url || "/").indexOf("?");

    const pathname =
      qIndex === -1 ? req.url || "/" : req.url?.slice(0, qIndex) || "/";

    const search = qIndex === -1 ? "" : req.url?.slice(qIndex) || "";

    super({
      protocol,
      host,
      pathname,
      search,
    });
  }
}
