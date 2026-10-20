import { describe } from "vitest";
import { unixSocketTests } from "./_unix-socket.ts";

describe.skipIf(process.platform === "win32")("deno unix socket", () => {
  unixSocketTests("deno run -A ./fixtures/unix-socket-server.ts", { tls: false, hostless: true });
});
