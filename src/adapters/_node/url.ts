import type { NodeServerRequest, NodeServerResponse } from "../../types.ts";
import { FastURL } from "../../_url.ts";

export class NodeRequestURL extends FastURL {
  #req: NodeServerRequest;

  constructor({ req }: { req: NodeServerRequest }) {
    const path = req.url || "/";
    if (path[0] === "/") {
      const qIndex = path.indexOf("?");
      const pathname = qIndex === -1 ? path : path?.slice(0, qIndex) || "/";
      const search = qIndex === -1 ? "" : path?.slice(qIndex) || "";

      const host =
        req.headers.host ||
        (req.headers[":authority"] as string) ||
        `${req.socket.localFamily === "IPv6" ? "[" + req.socket.localAddress + "]" : req.socket.localAddress}:${req.socket?.localPort || "80"}`;

      const protocol =
        (req.socket as any)?.encrypted ||
        req.headers["x-forwarded-proto"] === "https" ||
        req.headers[":scheme"] === "https"
          ? "https:"
          : "http:";

      super({
        protocol,
        host,
        pathname,
        search,
      });
    } else {
      super(path);
    }
    this.#req = req;
  }

  override get pathname(): string {
    return super.pathname;
  }

  override set pathname(value: string) {
    this._url.pathname = value;
    this.#req.url = this._url.pathname + this._url.search;
  }
}
