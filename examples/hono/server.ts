import { Hono } from "hono";

export default new Hono().get("/", (c) => c.html(`<h1>Hello, World!</h1>`));
