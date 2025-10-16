import { IncomingMessage } from "node:http";
import { WebRequestSocket } from "./socket.ts";

export class WebIncomingMessage extends IncomingMessage {
  constructor(req: Request, socket: WebRequestSocket) {
    super(socket);

    this.method = req.method;
    const url = new URL(req.url);
    this.url = url.pathname + url.search;
    this.headers = {};
    for (const [key, value] of req.headers.entries()) {
      this.headers[key.toLowerCase()] = value;
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
