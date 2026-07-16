import { describe, test, expect } from "vitest";
import http from "node:http";
import { patchGlobalRequest } from "../src/adapters/node.ts";

// Regression test for https://github.com/h3js/srvx/issues/207
//
// `patchGlobalRequest()` replaces `globalThis.Request` with a srvx subclass.
// A second srvx instance whose request module evaluates *after* that patch
// (as happens in a bundled build) must still wire up the web body helpers
// (formData/blob/arrayBuffer/bytes) instead of capturing the body-less
// subclass as the "native" Request. Otherwise those methods fall through to
// undici with the wrong receiver and throw.
const isNode = !globalThis.Deno && !globalThis.Bun;

describe.runIf(isNode)("node request body methods survive a patched globalThis.Request", () => {
  // Regression test for https://github.com/h3js/srvx/issues/249
  // Repeated `patchGlobalRequest()` calls must be idempotent and return the
  // exact class installed as `globalThis.Request`, not a fresh subclass.
  test("patchGlobalRequest() is idempotent", () => {
    const OriginalRequest = globalThis.Request;
    try {
      const first = patchGlobalRequest();
      expect(first).toBe(globalThis.Request);
      const second = patchGlobalRequest();
      expect(second).toBe(first);
      expect(second).toBe(globalThis.Request);
    } finally {
      globalThis.Request = OriginalRequest;
    }
  });

  test("formData/blob/arrayBuffer/bytes work after patchGlobalRequest()", async () => {
    // Patch the global, then load a *fresh* request module copy so its IIFE
    // runs while globalThis.Request is the patched subclass.
    patchGlobalRequest();
    const { NodeRequest } = await import("../src/adapters/_node/request.ts");

    const server = http.createServer((nodeReq, nodeRes) => {
      const req: any = new (NodeRequest as any)({ req: nodeReq, res: nodeRes });
      req
        .formData()
        .then((fd: FormData) => {
          nodeRes.statusCode = 200;
          nodeRes.end(String(fd.get("name")));
        })
        .catch((error: Error) => {
          nodeRes.statusCode = 500;
          nodeRes.end(`${error.constructor.name}: ${error.message}`);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    try {
      const res = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=alice",
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(text).toBe("alice");
    } finally {
      server.close();
    }
  });
});
