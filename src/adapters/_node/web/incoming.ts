import type { ServerRequest } from "../../../types.ts";
import { IncomingMessage } from "node:http";
import { WebRequestSocket } from "./socket.ts";
import { FastURL } from "../../../_url.ts";

export class WebIncomingMessage extends IncomingMessage {
  constructor(req: ServerRequest, socket: WebRequestSocket) {
    super(socket);

    this.method = req.method;
    const url = (req._url ??= new FastURL(req.url));
    this.url = url.pathname + url.search;

    for (const [key, value] of req.headers.entries()) {
      this.headers[key.toLowerCase()] = value;
    }
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      !this.headers["content-length"] &&
      !this.headers["transfer-encoding"]
    ) {
      this.headers["transfer-encoding"] = "chunked";
    }

    const onData = (chunk: any) => {
      this.push(chunk);
    };
    socket.on("data", onData);
    socket.once("end", () => {
      this.emit("end");
      this.off("data", onData);
    });
  }
}
