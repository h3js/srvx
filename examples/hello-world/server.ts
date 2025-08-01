export default {
  // https://srvx.h3.dev/guide/options
  port: 3000,
  fetch(req: Request) {
    return new Response("Hello, World!");
  },
};
