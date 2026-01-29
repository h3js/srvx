import { json } from "node:stream/consumers";

export async function fetchHandler(req) {
  const body = await req.json();
  return new Response(JSON.stringify(body), {
    headers: {
      "x-test": req.headers.get("x-test"),
      "Content-Type": "application/json;charset=UTF-8",
    },
  });
}

export async function nodeHandler(req, res) {
  const body = await readBody(req);
  res.setHeader("x-test", req.headers["x-test"] || "");
  res.setHeader("Content-Type", "application/json;charset=UTF-8");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req
      .on("data", (chunk) => {
        chunks.push(chunk);
      })
      .on("end", () => {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}
