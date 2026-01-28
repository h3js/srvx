export default {
  // https://srvx.h3.dev/guide/options
  port: 3000,
  fetch(req: Request) {
    return Response.json({ hello: "world!" });
  },
};
