import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.setHeader("x-test", _req.headers["x-test"] || "");
  res.end("Hello!");
});

server.listen(3000);
