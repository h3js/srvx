import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // res.end("OK");
  const stream = Readable.from(["Hello, ", "World!", "\n"]);
  stream.pipe(res);
}

// process
//   .getBuiltinModule("node:http")
//   .createServer(handler)
//   .listen(3000, () => {
//     console.log("Server is running on http://localhost:3000");
//   });
