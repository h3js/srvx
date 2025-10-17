import type { AddressInfo, Socket as NodeSocket } from "node:net";
import type { SocketReadyState } from "node:net";
import type { WebServerResponse } from "./response.ts";

import { Duplex } from "node:stream";

// https://github.com/nodejs/node/blob/main/lib/internal/streams/duplex.js
// https://github.com/nodejs/node/blob/main/lib/internal/webstreams/adapters.js

/**
 * Events:
 * - Readable (req from client): readable => data => end (push(null)) => error => close
 * - Writable (res to client): pipe => unpipe => drain => finish (end called) => error => close
 */

export class WebRequestSocket extends Duplex implements NodeSocket {
  _httpMessage?: WebServerResponse;
  autoSelectFamilyAttemptedAddresses: string[] = [];
  bufferSize: number = 0;
  bytesRead: number = 0;
  bytesWritten: number = 0;
  connecting: boolean = false;
  pending: boolean = false;
  readyState: SocketReadyState = "open";

  #request: Request;

  #timeoutTimer?: ReturnType<typeof setTimeout>;

  #reqReader?: ReadableStreamDefaultReader<Uint8Array>;

  #headersWritten?: boolean;
  #_writeBody!: (chunk: Uint8Array) => void;
  _webResBody: ReadableStream;

  constructor(request: Request) {
    super({
      signal: request.signal,
      allowHalfOpen: true,
    });

    this.#request = request;

    this._webResBody = new ReadableStream({
      start: (controller) => {
        this.#_writeBody = controller.enqueue.bind(controller);
        this.once("finish", () => {
          this.readyState = "closed";
          controller.close();
        });
      },
    });
  }

  setTimeout(ms?: number, cb?: () => void): this {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return this;
    if (cb) this.on("timeout", cb);
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    if (ms > 0) {
      this.#timeoutTimer = setTimeout(() => this.emit("timeout"), ms);
    }
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  destroySoon(): void {
    this.destroy();
  }

  connect(): this {
    return this;
  }

  resetAndDestroy(): this {
    this.destroy();
    return this;
  }

  address(): AddressInfo {
    return { address: "", family: "", port: 0 };
  }

  // ---------- Duplex Internals ----------

  override _read(_size: number): void {
    const reader = (this.#reqReader ??= this.#request.body?.getReader());
    if (!reader) {
      this.push(null);
      return;
    }
    reader
      .read()
      .then((res) => this._onRead(res))
      .catch((error) => {
        this.emit("error", error);
      });
  }

  _onRead(res: { done: boolean; value?: Uint8Array }): void {
    if (res.done) {
      this.push(null);
      return;
    }
    if (res.value) {
      this.bytesRead += res.value.byteLength;
      this.push(res.value);
    }
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#headersWritten) {
      this.#_writeBody(
        typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk,
      );
    } else if (chunk?.length > 0) {
      this.#headersWritten = true;
      const headerEnd = chunk.lastIndexOf("\r\n\r\n");
      if (headerEnd === -1) {
        throw new Error("Invalid HTTP headers chunk!");
      }
      if (headerEnd < chunk.length - 4) {
        const bodyChunk = chunk.slice(headerEnd + 4);
        this.#_writeBody(
          typeof bodyChunk === "string"
            ? Buffer.from(bodyChunk, encoding)
            : bodyChunk,
        );
      }
    }
    callback(null);
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback(null);
  }

  override _destroy(
    err: Error | null,
    cb: (error?: Error | null) => void,
  ): void {
    if (this.#timeoutTimer) {
      clearTimeout(this.#timeoutTimer);
    }
    if (this.#reqReader) {
      this.#reqReader.cancel().catch((error) => {
        console.error(error);
      });
    }
    this.readyState = "closed";
    cb(err ?? undefined);
  }
}
