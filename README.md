# λ srvx

<!-- automd:badges color=yellow packagephobia -->

[![npm version](https://img.shields.io/npm/v/srvx?color=yellow)](https://npmjs.com/package/srvx)
[![npm downloads](https://img.shields.io/npm/dm/srvx?color=yellow)](https://npm.chart.dev/srvx)
[![bundle size](https://img.shields.io/bundlephobia/minzip/srvx?color=yellow)](https://bundlephobia.com/package/srvx)
[![install size](https://badgen.net/packagephobia/install/srvx?color=yellow)](https://packagephobia.com/result?p=srvx)

<!-- /automd -->

Universal Server based on web standards. Works with [Deno](https://deno.com/), [Bun](https://bun.sh/) and [Node.js](https://nodejs.org/en).

- ✅ Zero dependency
- ✅ Full featured CLI with watcher, error handler, serve static and logger
- ✅ Seamless runtime integration with same API ([handler](https://srvx.h3.dev/guide/handler) and [instance](https://srvx.h3.dev/guide/server)).
- ✅ Zero overhead [Deno](https://deno.com/) and [Bun](https://bun.sh/) support.
- ✅ [Node.js compatibility](https://srvx.h3.dev/guide/node) with [~96.98%](https://github.com/h3js/srvx/tree/main/test/bench-node) native performance.

## Quick start

```js
// server.ts
export default {
  port: 3000,
  fetch(request: Request) {
    return new Response("👋 Hello there!");
  },
};
```

```bash
$ npx srvx dev
```

👉 **Visit the 📖 [Documentation](https://srvx.h3.dev/) to learn more.**

## Examples

[➤ Online Playground](https://stackblitz.com/edit/h3js-srvx-ekbf1eyb?file=server.mjs&startScript=dev)

<!-- automd:examples -->

| Example       | Source                                          | Try                                           |
| ------------- | ----------------------------------------------- | --------------------------------------------- |
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
