import { ServerResponse } from "node:http";
import { WebRequestSocket } from "./socket.ts";
import type { WebIncomingMessage } from "./incoming.ts";

export class WebServerResponse extends ServerResponse {
  #socket: WebRequestSocket;

  constructor(req: WebIncomingMessage, socket: WebRequestSocket) {
    super(req);
    this.assignSocket(socket);

    this.once("finish", () => {
      socket.end();
    });

    this.#socket = socket;

    // Express can override prototype so we have to bind methods
    this.waitToFinish = this.waitToFinish.bind(this);
    this.toWebResponse = this.toWebResponse.bind(this);
  }

  waitToFinish(): Promise<void> {
    if (this.writableEnded) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.on("finish", () => resolve());
      this.on("error", (err) => reject(err));
    });
  }

  async toWebResponse(): Promise<Response> {
    await this.waitToFinish();

    const headers: [string, string][] = [];

    // this.getHeaders() is unreliable because it misses direct writeHead() calls
    const httpHeader = (this as any)._header?.split("\r\n");
    for (let i = 1; httpHeader && i < httpHeader.length; i++) {
      const sepIndex = httpHeader[i].indexOf(": ");
      if (sepIndex === -1) continue;
      const key = httpHeader[i].slice(0, Math.max(0, sepIndex));
      const value = httpHeader[i].slice(Math.max(0, sepIndex + 2));
      if (!key) continue;
      headers.push([key, value]);
    }

    return new Response(this.#socket._webResBody, {
      status: this.statusCode,
      statusText: this.statusMessage,
      headers: headers,
    });
  }
}
