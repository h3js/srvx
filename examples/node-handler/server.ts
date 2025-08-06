import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const stream = Readable.from(["Hello, ", "World!", "\n"]);
  stream.pipe(res);
}
