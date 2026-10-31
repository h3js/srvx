import { describe } from "vitest";
import { unixSocketTests } from "./_unix-socket.ts";

describe.skipIf(process.platform === "win32")("node unix socket", () => {
  unixSocketTests("node --no-warnings ./fixtures/unix-socket-server.ts", {
    tls: true,
    hostless: true,
  });
});
