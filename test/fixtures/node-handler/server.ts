// Fixture: Node.js style handler
import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("node-handler");
}
