import { plugin as ws } from "crossws/server";

export default {
  // https://srvx.h3.dev/guide/options
  port: 3000,
  plugins: [
    ws({
      // https://crossws.h3.dev/guide/hooks
      open(peer) {
        console.log("[ws] open", peer);
        peer.send({ user: "server", message: `Welcome ${peer}!` });
      },

      message(peer, message) {
        console.log("[ws] message", message);
        if (message.text().includes("ping")) {
          peer.send({ user: "server", message: "pong" });
        } else {
          peer.send({ user: peer.toString(), message: message.toString() });
        }
      },

      close(peer, event) {
        console.log("[ws] close", peer, event);
      },

      error(peer, error) {
        console.log("[ws] error", peer, error);
      },
    }),
  ],
  fetch(req: Request) {
    return new Response(undefined, { status: 404 });
  },
};
