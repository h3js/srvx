import { describe } from "vitest";
import { unixSocketTests } from "./_unix-socket.ts";

describe.skipIf(process.platform === "win32")("bun unix socket", () => {
  unixSocketTests("bun run ./fixtures/unix-socket-server.ts", { tls: true });
});
