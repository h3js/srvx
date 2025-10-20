export function fetchHandler(req) {
  return new Response("Hello!", {
    headers: { "x-test": req.headers.get("x-test") },
  });
}

export function nodeHandler(_req, res) {
  res.setHeader("x-test", _req.headers["x-test"] || "");
  res.end("Hello!");
}
