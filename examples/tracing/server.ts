import { tracingPlugin } from "srvx/tracing";

export default {
  plugins: [tracingPlugin()],
  fetch(req: Request) {
    return Response.json({ hello: "world!" });
  },
};

// --- debug tracing channels ---

debugChannel("srvx.middleware");
debugChannel("srvx.fetch");

function debugChannel(name: string) {
  const { tracingChannel } = process.getBuiltinModule(
    "node:diagnostics_channel",
  );

  const log = (...args: unknown[]) => console.log(`[tracing:${name}]`, ...args);
  const noop = () => {};
  const serializeData = (data: any) =>
    Object.entries(data)
      .map(([key, value]) => {
        if (key === "request") {
          return `request(url=${(value as Request).url})`;
        }
        if (key === "server") {
          return "server";
        }
        if (key === "result") {
          return `result(status=${(value as Response).status})`;
        }
        return `${key}=${value}`;
      })
      .join(", ");

  tracingChannel(name).subscribe({
    start: noop,
    end: noop,
    asyncStart: (data) => log("asyncStart", serializeData(data)),
    asyncEnd: (data) => log("asyncEnd", serializeData(data)),
    error: (data) => log("error", serializeData(data)),
  });
}
