# 💥 srvx

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/srvx?color=yellow)](https://npmjs.com/package/srvx)
[![npm downloads](https://img.shields.io/npm/dm/srvx?color=yellow)](https://npm.chart.dev/srvx)

<!-- /automd -->

Universal Server API based on web platform standards. Works with [Deno](https://deno.com/), [Bun](https://bun.sh/) and [Node.js](https://nodejs.org/en).

- ✅ Seamless runtime integration with identical usage ([handler](https://srvx.h3.dev/guide/handler) and [instance](https://srvx.h3.dev/guide/server))
- ✅ Zero overhead [Deno](https://deno.com/) and [Bun](https://bun.sh/) support
- ✅ [Node.js compatibility](https://srvx.h3.dev/guide/node) with ~native perf and [fast response](https://srvx.h3.dev/guide/node#fast-response) support

## Quick start

```js
import { serve } from "srvx";

const server = serve({
  port: 3000,
  fetch(request) {
    return new Response("👋 Hello there!");
  },
});
```

👉 **Visit the 📖 [Documentation](https://srvx.h3.dev/) to learn more.**

## Examples

[➤Online Playground](https://stackblitz.com/fork/github/h3js/srvx/tree/main/examples/stackblitz?startScript=dev&file=server.mjs)

<!-- automd:examples -->

| Example       | Source                                          | Try                                           |
| ------------- | ----------------------------------------------- | --------------------------------------------- |
| `elysia`      | [examples/elysia](./examples/elysia/)           | `npx giget gh:h3js/srvx/examples/elysia`      |
| `h3`          | [examples/h3](./examples/h3/)                   | `npx giget gh:h3js/srvx/examples/h3`          |
| `hello-world` | [examples/hello-world](./examples/hello-world/) | `npx giget gh:h3js/srvx/examples/hello-world` |
| `hono`        | [examples/hono](./examples/hono/)               | `npx giget gh:h3js/srvx/examples/hono`        |
| `websocket`   | [examples/websocket](./examples/websocket/)     | `npx giget gh:h3js/srvx/examples/websocket`   |

<!-- /automd -->

## Contribution

- Clone this repository
- Install the latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- **Prepare stub mode using `pnpm build --stub`**
- Run interactive tests using `pnpm dev`

## License

<!-- automd:contributors author=pi0 license=MIT -->

Published under the [MIT](https://github.com/h3js/srvx/blob/main/LICENSE) license.
Made by [@pi0](https://github.com/pi0) and [community](https://github.com/h3js/srvx/graphs/contributors) 💛
<br><br>
<a href="https://github.com/h3js/srvx/graphs/contributors">
<img src="https://contrib.rocks/image?repo=h3js/srvx" />
</a>

<!-- /automd -->

<!-- automd:with-automd -->

---

_🤖 auto updated with [automd](https://automd.unjs.io)_

<!-- /automd -->
