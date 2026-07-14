import type { ServerRequest } from "../../../types.ts";
import { IncomingMessage } from "node:http";
import { WebRequestSocket } from "./socket.ts";
import { FastURL } from "../../../_url.ts";

export class WebIncomingMessage extends IncomingMessage {
  #socket: WebRequestSocket;

  constructor(req: ServerRequest, socket: WebRequestSocket) {
    super(socket);

    this.#socket = socket;

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
      // Honor backpressure: if the readable buffer is full, pause the source
      // socket so the entire upload isn't buffered in memory. `_read()` resumes
      // it once the consumer drains.
      if (!this.push(chunk)) {
        socket.pause();
      }
    };
    socket.on("data", onData);
    socket.once("end", () => {
      // Signal EOF via `push(null)` rather than a manual `emit("end")`. Emitting
      // "end" directly races consumers that attach body listeners after an
      // `await` (e.g. async middleware in front of `express.json()`) causing a
      // permanent hang. Mark the message complete first (as Node's HTTP parser
      // does) so `req.complete` is true, then push EOF so the Readable machinery
      // emits "end" at the right time.
      this.complete = true;
      this.push(null);
      this.off("data", onData);
    });
  }

  override _read(_size: number): void {
    // This message is fed manually from the socket "data" listener above rather
    // than by Node's HTTP parser. Resume the (possibly backpressure-paused)
    // source when the consumer asks for more data.
    this.#socket.resume();
  }

  override _destroy(_err: Error | null, cb: (error?: Error | null) => void): void {
    // The bridging socket has its own lifecycle (managed by WebServerResponse
    // and WebRequestSocket). When this readable ends, Node's default
    // `autoDestroy` would otherwise invoke `IncomingMessage._destroy`, which
    // tears the socket down and can abort the response before it finishes
    // flushing. Keep teardown a no-op here so the socket survives.
    cb();
  }
}
