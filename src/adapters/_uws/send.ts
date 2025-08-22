import type { UWSServerResponse } from "../../types.ts";
import type { UWSResponse } from "./response.ts";

export async function sendUWSResponse(
  res: UWSServerResponse,
  webRes: Response | UWSResponse,
): Promise<void> {
  if (res.aborted) {
    return;
  }

  if (!webRes) {
    res.cork(() => {
      res.writeStatus("500");
      res.end();
    });
    return;
  }

  // Fast path for UWSResponse
  if ((webRes as UWSResponse).uwsResponse) {
    const uwsRes = (webRes as UWSResponse).uwsResponse();
    // UWSResponse body can be a stream, which is not supported by fast path.
    if (!(uwsRes.body instanceof ReadableStream)) {
      res.cork(() => {
        res.writeStatus(`${uwsRes.status} ${uwsRes.statusText}`);
        for (const [key, value] of uwsRes.headers) {
          res.writeHeader(key, value);
        }
        if (uwsRes.body) {
          res.end(uwsRes.body as string);
        } else {
          res.end();
        }
      });
      return;
    }
  }

  // Slow path for standard Response or streaming UWSResponse
  const body = webRes.body ? await webRes.arrayBuffer() : undefined;

  if (res.aborted) {
    return;
  }

  res.cork(() => {
    res.writeStatus(`${webRes.status} ${webRes.statusText}`);
    for (const [key, value] of webRes.headers) {
      res.writeHeader(key, value);
    }
    if (body) {
      res.end(body);
    } else {
      res.end();
    }
  });
}
