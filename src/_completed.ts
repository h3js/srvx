import type { ServerHandler, ServerRequest } from "./types.ts";
import { toNativeResponse } from "./_utils.ts";

/**
 * Serve `request` through `handler`, backing `request.completed` by tracking the
 * response body. For runtimes with no native "response sent" signal (Bun, Deno
 * when `info.completed` is missing).
 *
 * The body is only wrapped when `request.completed` was read before the
 * response was handed back, so the default path stays allocation-free. Read
 * any later, it is too late to track the body and the promise resolves at once.
 */
export function serveWithCompletion(
  request: ServerRequest,
  handler: ServerHandler,
): Response | Promise<Response> {
  let completion: ResponseCompletion | undefined;
  let handedOff = false;
  Object.defineProperty(request, "completed", {
    enumerable: true,
    get: () => {
      if (!completion) {
        completion = new ResponseCompletion(request.signal);
        if (handedOff) completion.settle();
      }
      return completion.promise;
    },
  });
  // `res` is undefined when the handler threw: the runtime answers with its own
  // error response, which is out of reach here.
  const handOff = (res?: Response): Response | undefined => {
    handedOff = true;
    return completion ? completion.track(res) : res;
  };
  let res: Response | Promise<Response>;
  try {
    res = handler(request);
  } catch (error) {
    handOff();
    throw error;
  }
  if (typeof (res as Promise<Response>)?.then === "function") {
    return (res as Promise<Response>).then(
      (res) => handOff(toNativeResponse(res) as Response)!,
      (error) => {
        handOff();
        throw error;
      },
    );
  }
  return handOff(toNativeResponse(res) as Response)!;
}

class ResponseCompletion {
  readonly promise: Promise<void>;
  settle!: () => void;

  constructor(signal: AbortSignal) {
    this.promise = new Promise((resolve) => (this.settle = resolve));
    // Client went away before (or while) the body was read.
    signal.addEventListener("abort", this.settle, { once: true });
  }

  track(res: Response | undefined): Response | undefined {
    const body = res?.body;
    if (!res || !body) {
      this.settle();
      return res;
    }
    const settle = this.settle;
    const reader = body.getReader();
    // `highWaterMark: 0` pulls only when the runtime reads, so the last pull
    // (and `settle`) lines up with the runtime consuming the end of the body.
    const tracked = new ReadableStream(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              settle();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            controller.error(error);
            settle();
          }
        },
        cancel(reason) {
          settle();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(tracked, res);
  }
}
