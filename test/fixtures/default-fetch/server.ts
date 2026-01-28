// Fixture: default.fetch export
export default {
  fetch: (request: Request): Response => {
    return new Response("default-fetch");
  },
};
