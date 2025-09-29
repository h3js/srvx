import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/", () => "Hello, World!");

await fastify.ready();

export default fastify.routing;
