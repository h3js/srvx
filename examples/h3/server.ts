import { H3, html } from "h3";

export default new H3().get("/", (e) => html(e, `<h1>Hello, World!</h1>`));
