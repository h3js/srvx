/** @jsx h */
import { h, renderSSR } from "nano-jsx";

export default {
  fetch() {
    const html = renderSSR(() => <h1>Hello, World!</h1>);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  },
};
