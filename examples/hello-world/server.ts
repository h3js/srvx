export default {
  // https://srvx.h3.dev/guide/options
  port: 3000,
  async fetch(req: Request) {
    return Response.json({
      url: req.url,
      method: req.method,
      body: await req.text(),
      headers: Object.fromEntries(req.headers),
    });
  },
};
