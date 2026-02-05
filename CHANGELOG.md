# Changelog

## v0.11.2

[compare changes](https://github.com/h3js/srvx/compare/v0.11.1...v0.11.2)

### 💅 Refactors

- **tracing:** Rename tracing channel `h3.fetch` to `h3.request` ([#176](https://github.com/h3js/srvx/pull/176))

### 🏡 Chore

- Apply automated updates ([54acbbf](https://github.com/h3js/srvx/commit/54acbbf))
- Avoid adding version to docs ([e644208](https://github.com/h3js/srvx/commit/e644208))

### ❤️ Contributors

- Abdelrahman Awad <abdelrahman.awad@sentry.io>
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.11.1

[compare changes](https://github.com/h3js/srvx/compare/v0.11.0...v0.11.1)

### 🚀 Enhancements

- **cli:** Allow overriding meta ([0cad0a7](https://github.com/h3js/srvx/commit/0cad0a7))

### 🩹 Fixes

- **cli:** Enable graceful shutdown only for prod ([e57ada8](https://github.com/h3js/srvx/commit/e57ada8))
- **cli:** Log versions in main process ([674ca46](https://github.com/h3js/srvx/commit/674ca46))

### 💅 Refactors

- Improve graceful shutdown behavior ([54e7074](https://github.com/h3js/srvx/commit/54e7074))
- **cli:** Improve serve mode ([92a06a5](https://github.com/h3js/srvx/commit/92a06a5))
- **cli:** Bundle srvx meta ([7420599](https://github.com/h3js/srvx/commit/7420599))

### 🏡 Chore

- Apply automated updates ([07d7caf](https://github.com/h3js/srvx/commit/07d7caf))
- Apply automated updates ([b6d5668](https://github.com/h3js/srvx/commit/b6d5668))
- Apply automated updates ([359a728](https://github.com/h3js/srvx/commit/359a728))
- Update undocs ([3c87afc](https://github.com/h3js/srvx/commit/3c87afc))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.11.0

[compare changes](https://github.com/h3js/srvx/compare/v0.10.1...v0.11.0)

### 🚀 Enhancements

- Support `req.rawBody: Buffer` in google cloud functions ([#166](https://github.com/h3js/srvx/pull/166))
- `loadServerEntry` ([#168](https://github.com/h3js/srvx/pull/168))
- `srvx fetch` ([#169](https://github.com/h3js/srvx/pull/169))
- **loader:** Extended options ([#173](https://github.com/h3js/srvx/pull/173))
- Export `cliFetch` util ([#174](https://github.com/h3js/srvx/pull/174))
- **cli:** Add verbose output for entry file and node compat mode in `cliFetch` ([98b35cc](https://github.com/h3js/srvx/commit/98b35cc))
- **cli:** Fallback to global fetch ([17e115b](https://github.com/h3js/srvx/commit/17e115b))
- **cli:** Default user agent and accept header ([765282e](https://github.com/h3js/srvx/commit/765282e))
- **cli:** `srvx curl` alias ([169e26f](https://github.com/h3js/srvx/commit/169e26f))
- `aws-lambda` adapter and utils ([#104](https://github.com/h3js/srvx/pull/104))

### 🩹 Fixes

- Externalize type pkgs ([43c000a](https://github.com/h3js/srvx/commit/43c000a))
- **cli:** Enable `gracefulShutdown` only in production mode ([85cce89](https://github.com/h3js/srvx/commit/85cce89))
- **loader:** Optional access to `mod` ([a2a65fa](https://github.com/h3js/srvx/commit/a2a65fa))
- **loader:** Always call listen callback ([bc92090](https://github.com/h3js/srvx/commit/bc92090))
- **loader:** Mock `server.address()` in programmatic mode ([c9bb7c6](https://github.com/h3js/srvx/commit/c9bb7c6))
- **cli:** Use `localhost` as default hostname ([716408f](https://github.com/h3js/srvx/commit/716408f))
- **cli:** Remove conflicting `H` alias ([7dce970](https://github.com/h3js/srvx/commit/7dce970))
- **cli:** Throw error when no static dir and entry exist ([eaa99aa](https://github.com/h3js/srvx/commit/eaa99aa))
- **cli:** Fixed path to cli entry ([6ad9563](https://github.com/h3js/srvx/commit/6ad9563))
- **cli:** Remove hardcoded srvx command from usage ([3b224b8](https://github.com/h3js/srvx/commit/3b224b8))
- **loader:** Use default export as web handler when has less than two args ([3fc370c](https://github.com/h3js/srvx/commit/3fc370c))
- **cli:** Normalize urls ([f4a75fa](https://github.com/h3js/srvx/commit/f4a75fa))

### 💅 Refactors

- **loader:** Safer search path for default server entry ([8933e6b](https://github.com/h3js/srvx/commit/8933e6b))
- ⚠️ Rewamp cli ([#175](https://github.com/h3js/srvx/pull/175))
- **cli:** Improve fetch mode ([20796e2](https://github.com/h3js/srvx/commit/20796e2))
- Add missing runtime types ([5bcec0d](https://github.com/h3js/srvx/commit/5bcec0d))

### 📖 Documentation

- **cli:** Add JSDoc comments to cliFetch options ([262e6b2](https://github.com/h3js/srvx/commit/262e6b2))

### 📦 Build

- Fix cli version ([b438181](https://github.com/h3js/srvx/commit/b438181))

### 🏡 Chore

- Update deps ([c187dfc](https://github.com/h3js/srvx/commit/c187dfc))
- Update deps ([09f7b5d](https://github.com/h3js/srvx/commit/09f7b5d))
- Update readme ([6da8b18](https://github.com/h3js/srvx/commit/6da8b18))
- Migrate to oxlint and oxfmt ([3df52ee](https://github.com/h3js/srvx/commit/3df52ee))
- Rename typecheck script ([7a04c69](https://github.com/h3js/srvx/commit/7a04c69))
- Update tests ([0ec7758](https://github.com/h3js/srvx/commit/0ec7758))
- Update cli usage ([af7a46e](https://github.com/h3js/srvx/commit/af7a46e))
- Update docs ([516dd9e](https://github.com/h3js/srvx/commit/516dd9e))
- Update deps ([f06bb42](https://github.com/h3js/srvx/commit/f06bb42))

#### ⚠️ Breaking Changes

- ⚠️ Rewamp cli ([#175](https://github.com/h3js/srvx/pull/175))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Oskar Lebuda <oskar.lebuda@enp.pl>
- Nikita Lvov ([@niklv](https://github.com/niklv))

## v0.10.1

[compare changes](https://github.com/h3js/srvx/compare/v0.10.0...v0.10.1)

### 🚀 Enhancements

- Support force close with double Control+C ([#163](https://github.com/h3js/srvx/pull/163))

### 🩹 Fixes

- **node:** Call request abort controller only on close ([#161](https://github.com/h3js/srvx/pull/161))
- **node:** Handle multiple close calls ([#164](https://github.com/h3js/srvx/pull/164))
- Handle non-parsable URLs in printListening ([#165](https://github.com/h3js/srvx/pull/165))

### 🏡 Chore

- Swtich to tsgo ([#159](https://github.com/h3js/srvx/pull/159))
- Update undocs ([2b57ffe](https://github.com/h3js/srvx/commit/2b57ffe))
- Update deps ([64a1485](https://github.com/h3js/srvx/commit/64a1485))
- Update deps ([b553658](https://github.com/h3js/srvx/commit/b553658))

### ✅ Tests

- Use vitest for bun ([#162](https://github.com/h3js/srvx/pull/162))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Oskar Lebuda <oskar.lebuda@enp.pl>

## v0.10.0

[compare changes](https://github.com/h3js/srvx/compare/v0.9.8...v0.10.0)

### 🩹 Fixes

- **types:** Split http1 and http2 handler types ([#154](https://github.com/h3js/srvx/pull/154))

### 💅 Refactors

- **node:** ⚠️ Avoid patching global request by default ([#155](https://github.com/h3js/srvx/pull/155))

### 📖 Documentation

- Add notes about `NodeRequest` ([f483611](https://github.com/h3js/srvx/commit/f483611))
- **node:** Also mention `req.clone()` ([7a88abf](https://github.com/h3js/srvx/commit/7a88abf))

### 🌊 Types

- Add `_request` type ([ddc4ac3](https://github.com/h3js/srvx/commit/ddc4ac3))

#### ⚠️ Breaking Changes

- **node:** ⚠️ Avoid patching global request by default ([#155](https://github.com/h3js/srvx/pull/155))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Kricsleo ([@kricsleo](https://github.com/kricsleo))

## v0.9.8

[compare changes](https://github.com/h3js/srvx/compare/v0.9.7...v0.9.8)

### 🚀 Enhancements

- Export `AdapterMeta` ([#151](https://github.com/h3js/srvx/pull/151))
- Experimental tracing channel support ([#141](https://github.com/h3js/srvx/pull/141))

### 🩹 Fixes

- **node:** Don't fire abort signal on normal request completion ([#153](https://github.com/h3js/srvx/pull/153))

### 🏡 Chore

- Update deps ([b79112e](https://github.com/h3js/srvx/commit/b79112e))
- Fix types ([206a708](https://github.com/h3js/srvx/commit/206a708))
- Update bench ([4b58e3f](https://github.com/h3js/srvx/commit/4b58e3f))
- Small refactors on #153 ([#153](https://github.com/h3js/srvx/issues/153))
- Add experimental jsdocs for tracing ([f4a7996](https://github.com/h3js/srvx/commit/f4a7996))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Abdelrahman Awad ([@logaretm](https://github.com/logaretm))
- Alpheus ([@alpheusmtx](https://github.com/alpheusmtx))
- David Citron ([@dcitron](https://github.com/dcitron))

## v0.9.7

[compare changes](https://github.com/h3js/srvx/compare/v0.9.6...v0.9.7)

### 🩹 Fixes

- **request:** Fix instanceof checks for extended Request class ([#147](https://github.com/h3js/srvx/pull/147))

### 🏡 Chore

- Update deps ([7107753](https://github.com/h3js/srvx/commit/7107753))
- Update obuild ([aebb3fd](https://github.com/h3js/srvx/commit/aebb3fd))
- Rollback vitest upgrade ([56ab0d7](https://github.com/h3js/srvx/commit/56ab0d7))
- Update deps ([cc8f86a](https://github.com/h3js/srvx/commit/cc8f86a))

### 🤖 CI

- Add pkg.pr.new ([4d590fe](https://github.com/h3js/srvx/commit/4d590fe))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Kricsleo ([@kricsleo](https://github.com/kricsleo))

## v0.9.6

[compare changes](https://github.com/h3js/srvx/compare/v0.9.5...v0.9.6)

### 🩹 Fixes

- **request:** Use unique global cache key ([ab38ea4](https://github.com/h3js/srvx/commit/ab38ea4))
- Handle no env vars for colors ([#146](https://github.com/h3js/srvx/pull/146))

### 🏡 Chore

- Upgrade vitest to v4 ([#138](https://github.com/h3js/srvx/pull/138))
- Update deps ([28dcbed](https://github.com/h3js/srvx/commit/28dcbed))

### ❤️ Contributors

- Ian Bobinac <ian.units@gmail.com>
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.9.5

[compare changes](https://github.com/h3js/srvx/compare/v0.9.3...v0.9.5)

### 🚀 Enhancements

- **node, deno, bun:** Validate server port range ([#137](https://github.com/h3js/srvx/pull/137))

### 🩹 Fixes

- Handle non promise and promise-like values for `waitUntil` ([ef71acd](https://github.com/h3js/srvx/commit/ef71acd))

### 💅 Refactors

- Improve gracefulShutdown dx ([3170f23](https://github.com/h3js/srvx/commit/3170f23))

### 📦 Build

- Better tree-shaking cli colors ([0973a59](https://github.com/h3js/srvx/commit/0973a59))

### 🏡 Chore

- **release:** V0.9.4 ([70917bf](https://github.com/h3js/srvx/commit/70917bf))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Abeer0 ([@iiio2](https://github.com/iiio2))

## v0.9.4

[compare changes](https://github.com/h3js/srvx/compare/v0.9.3...v0.9.4)

### 🩹 Fixes

- Handle non promise and promise-like values for `waitUntil` ([ef71acd](https://github.com/h3js/srvx/commit/ef71acd))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.9.3

[compare changes](https://github.com/h3js/srvx/compare/v0.9.2...v0.9.3)

### 🚀 Enhancements

- **node, deno, bun:** Graceful shutdown ([#136](https://github.com/h3js/srvx/pull/136))
- Support `SERVER_SHUTDOWN_TIMEOUT` and `SERVER_FORCE_SHUTDOWN_TIMEOUT` env variables ([00454db](https://github.com/h3js/srvx/commit/00454db))

### 🩹 Fixes

- **cli:** Avoid double close ([51dbad2](https://github.com/h3js/srvx/commit/51dbad2))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.9.2

[compare changes](https://github.com/h3js/srvx/compare/v0.9.1...v0.9.2)

### 🩹 Fixes

- Lazy inherit property symbols too ([e63a34d](https://github.com/h3js/srvx/commit/e63a34d))

### 🏡 Chore

- Add explicit build script to publish ([6f93cc7](https://github.com/h3js/srvx/commit/6f93cc7))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.9.1

[compare changes](https://github.com/h3js/srvx/compare/v0.9.0...v0.9.1)

### 📖 Documentation

- Update fetching node handlers ([d3a5cbe](https://github.com/h3js/srvx/commit/d3a5cbe))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.9.0

[compare changes](https://github.com/h3js/srvx/compare/v0.8.16...v0.9.0)

### 🚀 Enhancements

- `fetchNodeHandler` and `nodeToFetchHandler` ([#125](https://github.com/h3js/srvx/pull/125))
- **toWebHandler:** Accept fetch or node handler as input ([2b0e232](https://github.com/h3js/srvx/commit/2b0e232))
- Better `toNodeHandler` / `toFetchHandler` utils ([#130](https://github.com/h3js/srvx/pull/130))
- Implement `Symbol.hasInstance` for all super classes ([529b11b](https://github.com/h3js/srvx/commit/529b11b))

### 🔥 Performance

- Use and cache parsed/fast url when possible ([da1caba](https://github.com/h3js/srvx/commit/da1caba))
- **node:** Fast req body methods ([#134](https://github.com/h3js/srvx/pull/134))

### 🩹 Fixes

- **node:** Trigger abort signal when body read is done ([#122](https://github.com/h3js/srvx/pull/122))
- **node, deno:** Use flatten headers only for node ([#129](https://github.com/h3js/srvx/pull/129))
- **node:** Catch uncaught response stream error ([#135](https://github.com/h3js/srvx/pull/135))
- **node:** Lowercase req header keys when iterating ([6adeb8e](https://github.com/h3js/srvx/commit/6adeb8e))

### 💅 Refactors

- ⚠️ Use esm imports for node entry ([#126](https://github.com/h3js/srvx/pull/126))
- ⚠️ Avoid splitting `Set-Cookie` value ([#127](https://github.com/h3js/srvx/pull/127))
- Rename to `toWebHandler` ([3124480](https://github.com/h3js/srvx/commit/3124480))
- **node:** ⚠️ Reimplement fast headers based on raw headers ([#133](https://github.com/h3js/srvx/pull/133))
- Fix type issues ([83cc771](https://github.com/h3js/srvx/commit/83cc771))
- **node:** ⚠️ Hide some internals ([e93b29c](https://github.com/h3js/srvx/commit/e93b29c))

### 🏡 Chore

- Fix typo in fastify example package.json ([#124](https://github.com/h3js/srvx/pull/124))
- Update ci ([#131](https://github.com/h3js/srvx/pull/131))
- Remove unused file ([bcc085d](https://github.com/h3js/srvx/commit/bcc085d))
- Add note about `toFetchHandler` ([84fa36e](https://github.com/h3js/srvx/commit/84fa36e))
- Refactor bench implementation handlers ([db78e5f](https://github.com/h3js/srvx/commit/db78e5f))
- Update deps ([0d1ba69](https://github.com/h3js/srvx/commit/0d1ba69))
- Update benchs ([9eda551](https://github.com/h3js/srvx/commit/9eda551))

### ✅ Tests

- Better abort tests ([#123](https://github.com/h3js/srvx/pull/123))
- Run node-compat tests against other runtimes ([#128](https://github.com/h3js/srvx/pull/128))

#### ⚠️ Breaking Changes

- ⚠️ Use esm imports for node entry ([#126](https://github.com/h3js/srvx/pull/126))
- ⚠️ Avoid splitting `Set-Cookie` value ([#127](https://github.com/h3js/srvx/pull/127))
- **node:** ⚠️ Reimplement fast headers based on raw headers ([#133](https://github.com/h3js/srvx/pull/133))
- **node:** ⚠️ Hide some internals ([e93b29c](https://github.com/h3js/srvx/commit/e93b29c))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Hiroshi Ogawa <hi.ogawa.zz@gmail.com>
- Wei Wang <wei@fastmail.com>
- Manuel Schiller <meisterpink@gmail.com>

## v0.8.16

[compare changes](https://github.com/h3js/srvx/compare/v0.8.15...v0.8.16)

### 🩹 Fixes

- **cli:** Correct middleware entry spread in serve function ([#119](https://github.com/h3js/srvx/pull/119))

### 📦 Build

- Inline and export `splitSetCookieString` ([#121](https://github.com/h3js/srvx/pull/121))

### ❤️ Contributors

- Kricsleo ([@kricsleo](https://github.com/kricsleo))
- Валентин Степанов ([@teleskop150750](https://github.com/teleskop150750))

## v0.8.15

[compare changes](https://github.com/h3js/srvx/compare/v0.8.14...v0.8.15)

### 🩹 Fixes

- Avoid inheriting `constructor` props ([3ecb746](https://github.com/h3js/srvx/commit/3ecb746))
- **node:** Fix instance check against native `Request` after patching ([c7e7b7f](https://github.com/h3js/srvx/commit/c7e7b7f))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.14

[compare changes](https://github.com/h3js/srvx/compare/v0.8.13...v0.8.14)

### 🚀 Enhancements

- **static:** Support custom html renderer ([604ee02](https://github.com/h3js/srvx/commit/604ee02))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.13

[compare changes](https://github.com/h3js/srvx/compare/v0.8.12...v0.8.13)

### 🩹 Fixes

- **node:** Sync `FastURL` pathname changes back to node `req.url` ([#118](https://github.com/h3js/srvx/pull/118))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.12

[compare changes](https://github.com/h3js/srvx/compare/v0.8.11...v0.8.12)

### 🩹 Fixes

- Safer access to `process.getBuiltinModule` ([#117](https://github.com/h3js/srvx/pull/117))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.11

[compare changes](https://github.com/h3js/srvx/compare/v0.8.10...v0.8.11)

### 🚀 Enhancements

- **node:** Support absolute paths in request line ([#116](https://github.com/h3js/srvx/pull/116))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.10

[compare changes](https://github.com/h3js/srvx/compare/v0.8.9...v0.8.10)

### 🩹 Fixes

- **cli:** Ensure child process is killed on exit ([#114](https://github.com/h3js/srvx/pull/114))

### 💅 Refactors

- Reimplement `FastURL` ([#112](https://github.com/h3js/srvx/pull/112))
- **node:** Rewrite `NodeRequestURL` based on `FastURL` ([#113](https://github.com/h3js/srvx/pull/113))

### 🏡 Chore

- Update deps ([946263d](https://github.com/h3js/srvx/commit/946263d))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.9

[compare changes](https://github.com/h3js/srvx/compare/v0.8.8...v0.8.9)

### 🩹 Fixes

- **node:** Safer global Request patch ([0e8d6da](https://github.com/h3js/srvx/commit/0e8d6da))

### 🏡 Chore

- Update benchs ([7e8782c](https://github.com/h3js/srvx/commit/7e8782c))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.8

[compare changes](https://github.com/h3js/srvx/compare/v0.8.7...v0.8.8)

### 🩹 Fixes

- **node:** Add back `req.runtime` ([d1a148b](https://github.com/h3js/srvx/commit/d1a148b))

### 💅 Refactors

- **node:** Improve `NodeRequest` wrapper ([#109](https://github.com/h3js/srvx/pull/109))
- **node:** Rewrite FastResponse ([#110](https://github.com/h3js/srvx/pull/110))
- **node:** Avoid top level `node:` imports ([d95ccb7](https://github.com/h3js/srvx/commit/d95ccb7))
- **node:** Improve instance types ([6e83952](https://github.com/h3js/srvx/commit/6e83952))

### 📖 Documentation

- **node:** Provide `async` keyword ([#107](https://github.com/h3js/srvx/pull/107))

### 🏡 Chore

- Update deps ([a2498c7](https://github.com/h3js/srvx/commit/a2498c7))
- Fix typo ([#106](https://github.com/h3js/srvx/pull/106))
- Update undocs ([663a039](https://github.com/h3js/srvx/commit/663a039))
- Update deps ([7e5844c](https://github.com/h3js/srvx/commit/7e5844c))
- Add fastify example ([42cb8bb](https://github.com/h3js/srvx/commit/42cb8bb))
- Apply automated updates ([b477382](https://github.com/h3js/srvx/commit/b477382))
- Update deps ([23ea4c5](https://github.com/h3js/srvx/commit/23ea4c5))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Abeer0 ([@iiio2](https://github.com/iiio2))
- Mohamed Attia ([@Speelwolf](https://github.com/Speelwolf))

## v0.8.7

[compare changes](https://github.com/h3js/srvx/compare/v0.8.6...v0.8.7)

### 🩹 Fixes

- Add missing `Server.serve` type ([#102](https://github.com/h3js/srvx/pull/102))

### 🌊 Types

- Declare optional `ServerRequest.context` ([dc6f868](https://github.com/h3js/srvx/commit/dc6f868))

### 🏡 Chore

- Remove `--experimental-strip-types` in scripts ([#105](https://github.com/h3js/srvx/pull/105))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Abeer0 ([@iiio2](https://github.com/iiio2))
- Oskar Lebuda <oskar.lebuda@enp.pl>

## v0.8.6

[compare changes](https://github.com/h3js/srvx/compare/v0.8.5...v0.8.6)

### 🚀 Enhancements

- **cli:** Support node.js and express handlers ([#98](https://github.com/h3js/srvx/pull/98))
- **cli:** Support `--import` for custom loader ([#99](https://github.com/h3js/srvx/pull/99))
- **cli:** Add `server/index` and jsx to defaults ([7c65bd2](https://github.com/h3js/srvx/commit/7c65bd2))
- **cli:** Set default `NODE_ENV` if not set before serve ([cfbb3d6](https://github.com/h3js/srvx/commit/cfbb3d6))

### 🩹 Fixes

- Cli color resets ([2ecc989](https://github.com/h3js/srvx/commit/2ecc989))
- **cli:** Exit if directory does not exists ([3a94ac8](https://github.com/h3js/srvx/commit/3a94ac8))

### 💅 Refactors

- **logger:** Better status colors ([1643985](https://github.com/h3js/srvx/commit/1643985))
- **cli:** Improve info message ([b97e4be](https://github.com/h3js/srvx/commit/b97e4be))
- **cli:** Always use sub process ([82ecc00](https://github.com/h3js/srvx/commit/82ecc00))

### 📖 Documentation

- Fix typo ([#96](https://github.com/h3js/srvx/pull/96))

### 📦 Build

- Lighter version injection to the bundle ([6b78daa](https://github.com/h3js/srvx/commit/6b78daa))

### 🏡 Chore

- Update eslint config ([ecc0b9c](https://github.com/h3js/srvx/commit/ecc0b9c))
- Apply automated updates ([076b9c4](https://github.com/h3js/srvx/commit/076b9c4))
- Update deps ([871e4f8](https://github.com/h3js/srvx/commit/871e4f8))
- Fix types ([936b31d](https://github.com/h3js/srvx/commit/936b31d))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Alpheus ([@alpheusmtx](https://github.com/alpheusmtx))

## v0.8.5

[compare changes](https://github.com/h3js/srvx/compare/v0.8.4...v0.8.5)

### 🩹 Fixes

- **cli:** Only add `--experimental-strip-types` flag to the safe range ([d00aa93](https://github.com/h3js/srvx/commit/d00aa93))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.4

[compare changes](https://github.com/h3js/srvx/compare/v0.8.3...v0.8.4)

### 🚀 Enhancements

- **cli:** Better hint for typescript support and Node.js version ([8c710af](https://github.com/h3js/srvx/commit/8c710af))

### 🩹 Fixes

- **cli:** Backward compatibility for ts support in older versions of Node.js 22 ([9ee024b](https://github.com/h3js/srvx/commit/9ee024b))

### 🏡 Chore

- Update examples to use latest ([338ea07](https://github.com/h3js/srvx/commit/338ea07))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.3

[compare changes](https://github.com/h3js/srvx/compare/v0.8.2...v0.8.3)

### 🚀 Enhancements

- Experimental cli ([#91](https://github.com/h3js/srvx/pull/91))
- **cli:** Auto detect entry ([6d9011d](https://github.com/h3js/srvx/commit/6d9011d))
- Basic serve static ([#93](https://github.com/h3js/srvx/pull/93))
- Basic logger ([#94](https://github.com/h3js/srvx/pull/94))
- **cli:** Support `.env` and `.env.local` in dev mode ([4cdd246](https://github.com/h3js/srvx/commit/4cdd246))

### 💅 Refactors

- Convert `serveStatic` to middleware ([c0f5bac](https://github.com/h3js/srvx/commit/c0f5bac))
- Simplify cli usage ([a30db56](https://github.com/h3js/srvx/commit/a30db56))
- **cli:** Minor tweaks ([0d86c7a](https://github.com/h3js/srvx/commit/0d86c7a))
- **cli:** Support serve static only ([20171c2](https://github.com/h3js/srvx/commit/20171c2))

### 📖 Documentation

- Prepare for `0.8.3` release ([#95](https://github.com/h3js/srvx/pull/95))

### 📦 Build

- Fix nightly releases ([2069b15](https://github.com/h3js/srvx/commit/2069b15))
- Fix cli bin script ([30db25c](https://github.com/h3js/srvx/commit/30db25c))

### 🏡 Chore

- Add CODEOWNERS ([e748bd3](https://github.com/h3js/srvx/commit/e748bd3))
- Update contribution section ([534a2bb](https://github.com/h3js/srvx/commit/534a2bb))
- Add examples ([79d14a2](https://github.com/h3js/srvx/commit/79d14a2))
- Fix typo ([45894fe](https://github.com/h3js/srvx/commit/45894fe))
- Add websocket example ([6d1c1aa](https://github.com/h3js/srvx/commit/6d1c1aa))
- Add `.npmrc` ([2493291](https://github.com/h3js/srvx/commit/2493291))
- List examples in readme ([a4eb14b](https://github.com/h3js/srvx/commit/a4eb14b))
- Update stackblitz ([b5ef3c9](https://github.com/h3js/srvx/commit/b5ef3c9))
- Add local `srvx` command ([d497e0c](https://github.com/h3js/srvx/commit/d497e0c))
- Add elysia example ([843408c](https://github.com/h3js/srvx/commit/843408c))
- Apply automated updates ([23d7015](https://github.com/h3js/srvx/commit/23d7015))
- Add service-worker example ([061fa31](https://github.com/h3js/srvx/commit/061fa31))
- Remove old playground ([1c249be](https://github.com/h3js/srvx/commit/1c249be))
- **cli:** Remove extra space ([3934b3b](https://github.com/h3js/srvx/commit/3934b3b))

### 🤖 CI

- Enable nightly channel ([b0a0a2b](https://github.com/h3js/srvx/commit/b0a0a2b))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Hong Minhee (洪 民憙) ([@dahlia](https://github.com/dahlia))

## v0.8.2

[compare changes](https://github.com/h3js/srvx/compare/v0.8.1...v0.8.2)

### 🚀 Enhancements

- **node:** Export `sendNodeResponse` ([add088f](https://github.com/h3js/srvx/commit/add088f))

### 🔥 Performance

- **node:** Use fast response for `.clone()` in fast paths ([e1e5a89](https://github.com/h3js/srvx/commit/e1e5a89))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.8.1

[compare changes](https://github.com/h3js/srvx/compare/v0.8.0...v0.8.1)

### 🚀 Enhancements

- **cloudflare:** Add request.ip ([#89](https://github.com/h3js/srvx/pull/89))

### 🩹 Fixes

- **node:** Add unsupported getters ([36615dc](https://github.com/h3js/srvx/commit/36615dc))

### 📖 Documentation

- Update ([#88](https://github.com/h3js/srvx/pull/88))

### 🏡 Chore

- Update deps ([b660bf4](https://github.com/h3js/srvx/commit/b660bf4))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Huseeiin ([@huseeiin](https://github.com/huseeiin))
- Vlad Sirenko ([@sirenkovladd](https://github.com/sirenkovladd))

## v0.8.0

[compare changes](https://github.com/h3js/srvx/compare/v0.7.5...v0.8.0)

### 💅 Refactors

- Improve `IsAny` type helper ([a0f5c7e](https://github.com/h3js/srvx/commit/a0f5c7e))

### 📦 Build

- ⚠️ Remove `/types` subpath ([#83](https://github.com/h3js/srvx/pull/83))

### 🌊 Types

- Allow augmenting `req.runtime.cloudflare.env` ([#84](https://github.com/h3js/srvx/pull/84))

### 🏡 Chore

- Update deps ([168bfe1](https://github.com/h3js/srvx/commit/168bfe1))
- Add readme for benchmarks ([d451ffa](https://github.com/h3js/srvx/commit/d451ffa))
- Update results ([3b7d0cf](https://github.com/h3js/srvx/commit/3b7d0cf))
- Shuffle bench order ([535e4f2](https://github.com/h3js/srvx/commit/535e4f2))

#### ⚠️ Breaking Changes

- ⚠️ Remove `/types` subpath ([#83](https://github.com/h3js/srvx/pull/83))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.7.5

[compare changes](https://github.com/h3js/srvx/compare/v0.7.4...v0.7.5)

### 💅 Refactors

- Remove unnecessary `__PURE__` ([699a100](https://github.com/h3js/srvx/commit/699a100))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.7.4

[compare changes](https://github.com/h3js/srvx/compare/v0.7.3...v0.7.4)

### 🚀 Enhancements

- Universal `request.waitUntil` ([#81](https://github.com/h3js/srvx/pull/81))

### 📦 Build

- Remove small side-effects from `service-worker` ([2ed12a9](https://github.com/h3js/srvx/commit/2ed12a9))

### 🏡 Chore

- Update undocs ([b872621](https://github.com/h3js/srvx/commit/b872621))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.7.3

[compare changes](https://github.com/h3js/srvx/compare/v0.7.2...v0.7.3)

### 🩹 Fixes

- **node:** Only use `req.headers` in `FastResponse` when initialized ([#79](https://github.com/h3js/srvx/pull/79))

### 💅 Refactors

- Include invalid header name in error message ([d0bf7dc](https://github.com/h3js/srvx/commit/d0bf7dc))

### 🏡 Chore

- Add `--watch` to playground scripts ([222580e](https://github.com/h3js/srvx/commit/222580e))
- Add `erasableSyntaxOnly` option to compiler options ([#77](https://github.com/h3js/srvx/pull/77))
- Update undocs ([5d263b1](https://github.com/h3js/srvx/commit/5d263b1))
- Build docs native dep ([7c8b337](https://github.com/h3js/srvx/commit/7c8b337))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Dirk De Visser <github@dirkdevisser.nl>
- Wind <hi@productdevbook.com>

## v0.7.2

[compare changes](https://github.com/h3js/srvx/compare/v0.7.1...v0.7.2)

### 🚀 Enhancements

- **node:** Call request abort signal ([#76](https://github.com/h3js/srvx/pull/76))

### 🩹 Fixes

- Match `runtime.name` ([3cfbbcb](https://github.com/h3js/srvx/commit/3cfbbcb))

### 📖 Documentation

- **guide/plugins:** Make middleware functions asynchronous ([#70](https://github.com/h3js/srvx/pull/70))
- **guide/bundler:** Improve bundle usage explanation ([#73](https://github.com/h3js/srvx/pull/73))

### 📦 Build

- Update obuild ([85875b9](https://github.com/h3js/srvx/commit/85875b9))

### 🏡 Chore

- Add bench for `@whatwg-node/server` ([e14b292](https://github.com/h3js/srvx/commit/e14b292))
- Update deps ([e6896aa](https://github.com/h3js/srvx/commit/e6896aa))
- Update play:node command ([9da1d3e](https://github.com/h3js/srvx/commit/9da1d3e))

### ❤️ Contributors

- Colin Ozanne ([@finxol](https://github.com/finxol))
- Pooya Parsa ([@pi0](https://github.com/pi0))
- Markthree ([@markthree](https://github.com/markthree))

## v0.7.1

[compare changes](https://github.com/h3js/srvx/compare/v0.7.0...v0.7.1)

### 📦 Build

- Fix `/types` subpath ([b40c165](https://github.com/h3js/srvx/commit/b40c165))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.7.0

[compare changes](https://github.com/h3js/srvx/compare/v0.6.0...v0.7.0)

### 🚀 Enhancements

- **node:** Support http2 ([#58](https://github.com/h3js/srvx/pull/58))
- ⚠️ Top level `middleware` and simplified plugins ([#67](https://github.com/h3js/srvx/pull/67))
- Clone options and init `middleware: []` ([16798c1](https://github.com/h3js/srvx/commit/16798c1))

### 🩹 Fixes

- Add missing types for `node.upgrade` ([7f66ac3](https://github.com/h3js/srvx/commit/7f66ac3))
- **url:** Always invalidate cached values ([059914d](https://github.com/h3js/srvx/commit/059914d))

### 💅 Refactors

- ⚠️ Remove experimental upgrade ([#68](https://github.com/h3js/srvx/pull/68))
- ⚠️ Use `process.getBuiltinModule` for node ([#69](https://github.com/h3js/srvx/pull/69))
- Move node compat to `adapters/_node` ([e594009](https://github.com/h3js/srvx/commit/e594009))

### 📦 Build

- Migrate to obuild ([ff883cf](https://github.com/h3js/srvx/commit/ff883cf))

### 🏡 Chore

- Fix lint issues ([f16da88](https://github.com/h3js/srvx/commit/f16da88))
- Update code style ([167c22c](https://github.com/h3js/srvx/commit/167c22c))
- Update middleware example ([e72ad59](https://github.com/h3js/srvx/commit/e72ad59))
- Remove unused import ([2f7a3c5](https://github.com/h3js/srvx/commit/2f7a3c5))
- Update deps ([b86b092](https://github.com/h3js/srvx/commit/b86b092))
- Update deno tests ([c5003af](https://github.com/h3js/srvx/commit/c5003af))

### ✅ Tests

- Add wpt setter tests for `FastURL` ([#66](https://github.com/h3js/srvx/pull/66))
- Add more coverage for `FastURL` ([7e8ebd2](https://github.com/h3js/srvx/commit/7e8ebd2))

#### ⚠️ Breaking Changes

- ⚠️ Top level `middleware` and simplified plugins ([#67](https://github.com/h3js/srvx/pull/67))
- ⚠️ Remove experimental upgrade ([#68](https://github.com/h3js/srvx/pull/68))
- ⚠️ Use `process.getBuiltinModule` for node ([#69](https://github.com/h3js/srvx/pull/69))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Oskar Lebuda <oskar.lebuda@enp.pl>

## v0.6.0

[compare changes](https://github.com/h3js/srvx/compare/v0.5.2...v0.6.0)

### 🚀 Enhancements

- ⚠️ Fetch middleware via plugins ([#62](https://github.com/h3js/srvx/pull/62))
- Support `upgrade` hook (experimental) ([#63](https://github.com/h3js/srvx/pull/63))

### 🩹 Fixes

- **node:** Handle additional response headers ([#64](https://github.com/h3js/srvx/pull/64))

### 💅 Refactors

- ⚠️ Rename `onError` hook to `error` for consistency ([471fe57](https://github.com/h3js/srvx/commit/471fe57))
- ⚠️ Rename to `FastURL` and `FastResponse` exports ([0fe9ed4](https://github.com/h3js/srvx/commit/0fe9ed4))

### 🏡 Chore

- Update bench script ([c0826c1](https://github.com/h3js/srvx/commit/c0826c1))

#### ⚠️ Breaking Changes

- ⚠️ Fetch middleware via plugins ([#62](https://github.com/h3js/srvx/pull/62))
- ⚠️ Rename `onError` hook to `error` for consistency ([471fe57](https://github.com/h3js/srvx/commit/471fe57))
- ⚠️ Rename to `FastURL` and `FastResponse` exports ([0fe9ed4](https://github.com/h3js/srvx/commit/0fe9ed4))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.5.2

[compare changes](https://github.com/h3js/srvx/compare/v0.5.1...v0.5.2)

### 🚀 Enhancements

- Fast `URL` for node, deno and bun ([b5f5239](https://github.com/h3js/srvx/commit/b5f5239))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.5.1

[compare changes](https://github.com/h3js/srvx/compare/v0.5.0...v0.5.1)

### 🩹 Fixes

- **service-worker:** Minor fixes ([63a42b5](https://github.com/h3js/srvx/commit/63a42b5))

### 🏡 Chore

- Apply automated updates ([248d0b5](https://github.com/h3js/srvx/commit/248d0b5))
- Update playground sw example to use cdn ([b333bd4](https://github.com/h3js/srvx/commit/b333bd4))
- Fix node compat internal types ([7862ab0](https://github.com/h3js/srvx/commit/7862ab0))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.5.0

[compare changes](https://github.com/h3js/srvx/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- Experimental service-worker adapter ([#53](https://github.com/h3js/srvx/pull/53))
- **service-worker:** Self-register support ([#55](https://github.com/h3js/srvx/pull/55))
- Generic adapter ([#56](https://github.com/h3js/srvx/pull/56))
- ⚠️ Print listening url by default ([#57](https://github.com/h3js/srvx/pull/57))
- Support `HOST` env for node, deno and bun ([2d94e28](https://github.com/h3js/srvx/commit/2d94e28))
- Add runtime agnostic error handler ([#48](https://github.com/h3js/srvx/pull/48))

### 💅 Refactors

- Improve types ([89bba05](https://github.com/h3js/srvx/commit/89bba05))

### 🏡 Chore

- Apply automated updates ([840e3a3](https://github.com/h3js/srvx/commit/840e3a3))
- Move to h3js org ([255cab1](https://github.com/h3js/srvx/commit/255cab1))
- Use pnpm for docs ([0c92f55](https://github.com/h3js/srvx/commit/0c92f55))
- Apply automated updates ([599c786](https://github.com/h3js/srvx/commit/599c786))
- Update deps ([3f18ddb](https://github.com/h3js/srvx/commit/3f18ddb))
- Rename `_utils` to `_uitils.node` ([71cbe57](https://github.com/h3js/srvx/commit/71cbe57))

#### ⚠️ Breaking Changes

- ⚠️ Print listening url by default ([#57](https://github.com/h3js/srvx/pull/57))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Daniel Perez ([@danielpza](https://github.com/danielpza))

## v0.4.0

[compare changes](https://github.com/h3dev/srvx/compare/v0.3.0...v0.4.0)

### 💅 Refactors

- ⚠️ Use `request.ip` and `request.runtime` ([#51](https://github.com/h3dev/srvx/pull/51))

### 🏡 Chore

- Apply automated updates ([59e28fa](https://github.com/h3dev/srvx/commit/59e28fa))

#### ⚠️ Breaking Changes

- ⚠️ Use `request.ip` and `request.runtime` ([#51](https://github.com/h3dev/srvx/pull/51))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.3.0

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.8...v0.3.0)

### 💅 Refactors

- ⚠️ Move extended request context under `request.x.*` ([#50](https://github.com/h3dev/srvx/pull/50))

### 📖 Documentation

- Improve quick start ([#49](https://github.com/h3dev/srvx/pull/49))

### 🏡 Chore

- Update editorconfig to include typescript files ([#47](https://github.com/h3dev/srvx/pull/47))

#### ⚠️ Breaking Changes

- ⚠️ Move extended request context under `request.x.*` ([#50](https://github.com/h3dev/srvx/pull/50))

### ❤️ Contributors

- Daniel Perez <danielpza@protonmail.com>
- Pooya Parsa ([@pi0](https://github.com/pi0))
- Sébastien Chopin <seb@nuxtlabs.com>

## v0.2.8

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.7...v0.2.8)

### 🚀 Enhancements

- **node:** Expose internal proxy classes ([0cdfa22](https://github.com/h3dev/srvx/commit/0cdfa22))
- **node:** Support Response static methods ([b9976a4](https://github.com/h3dev/srvx/commit/b9976a4))

### 🩹 Fixes

- **node:** Use `null` for unset headers ([#45](https://github.com/h3dev/srvx/pull/45))

### 💅 Refactors

- Remove unused symbols ([c726e40](https://github.com/h3dev/srvx/commit/c726e40))
- Accept node ctx for `NodeResponseHeaders` constructor ([8fe9241](https://github.com/h3dev/srvx/commit/8fe9241))

### 📦 Build

- Add types condition to top ([82e7fcc](https://github.com/h3dev/srvx/commit/82e7fcc))

### 🏡 Chore

- Update node tests ([#42](https://github.com/h3dev/srvx/pull/42))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Benny Yen ([@benny123tw](https://github.com/benny123tw))

## v0.2.7

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.6...v0.2.7)

### 🚀 Enhancements

- **node:** Expose `node` context to proxy interfaces ([5f20d9e](https://github.com/h3dev/srvx/commit/5f20d9e))

### 🩹 Fixes

- **node:** Make sure response constructor name is `Response` ([782ee13](https://github.com/h3dev/srvx/commit/782ee13))
- **node:** Make sure all proxies mimic global name and instance ([5883995](https://github.com/h3dev/srvx/commit/5883995))
- **node:** Use global Response for cloing ([effa940](https://github.com/h3dev/srvx/commit/effa940))
- **node:** Avoid conflict with undici prototype ([40cacf2](https://github.com/h3dev/srvx/commit/40cacf2))

### 💅 Refactors

- **types:** Fix typo for `BunFetchHandler` ([#41](https://github.com/h3dev/srvx/pull/41))

### 📦 Build

- Add `engines` field ([ea8a9c9](https://github.com/h3dev/srvx/commit/ea8a9c9))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Benny Yen ([@benny123tw](https://github.com/benny123tw))

## v0.2.6

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.5...v0.2.6)

### 🚀 Enhancements

- Support `tls` and `protocol` ([#38](https://github.com/h3dev/srvx/pull/38))

### 🔥 Performance

- **adapters/node:** Check `req._hasBody` once ([978a27d](https://github.com/h3dev/srvx/commit/978a27d))

### 🩹 Fixes

- **node:** Flatten headers to handle node slow path ([#40](https://github.com/h3dev/srvx/pull/40))

### 🏡 Chore

- Update readme ([#39](https://github.com/h3dev/srvx/pull/39))
- Update deps ([2b1f9f7](https://github.com/h3dev/srvx/commit/2b1f9f7))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Oskar Lebuda <oskar.lebuda@enp.pl>
- Markthree ([@markthree](https://github.com/markthree))
- Alexander Lichter ([@TheAlexLichter](https://github.com/TheAlexLichter))

## v0.2.5

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.3...v0.2.5)

### 🩹 Fixes

- Fix `Response` type export ([e8d25e9](https://github.com/h3dev/srvx/commit/e8d25e9))
- **node:** Set `Response` prototype for `NodeFastResponse` ([2e6a8a0](https://github.com/h3dev/srvx/commit/2e6a8a0))

### 🏡 Chore

- **release:** V0.2.4 ([d001e87](https://github.com/h3dev/srvx/commit/d001e87))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.4

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.3...v0.2.4)

### 🩹 Fixes

- Fix `Response` type export ([e8d25e9](https://github.com/h3dev/srvx/commit/e8d25e9))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.3

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.2...v0.2.3)

### 🩹 Fixes

- **node:** Use `headers.entries` when full Headers is set as init ([7f8cac8](https://github.com/h3dev/srvx/commit/7f8cac8))
- **node:** Make `req instanceof Request` working ([24b3f83](https://github.com/h3dev/srvx/commit/24b3f83))

### 📦 Build

- Fix types export ([#36](https://github.com/h3dev/srvx/pull/36))
- Add types export for `.` ([#37](https://github.com/h3dev/srvx/pull/37))

### 🏡 Chore

- **release:** V0.2.2 ([f015aa3](https://github.com/h3dev/srvx/commit/f015aa3))
- Lint ([f043d58](https://github.com/h3dev/srvx/commit/f043d58))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Oskar Lebuda ([@OskarLebuda](https://github.com/OskarLebuda))

## v0.2.2

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.1...v0.2.2)

### 🚀 Enhancements

- **node:** Support node readable stream ([bc72436](https://github.com/h3dev/srvx/commit/bc72436))

### 🩹 Fixes

- **node:** Don't send headers if already sent ([bbf6b86](https://github.com/h3dev/srvx/commit/bbf6b86))
- Add `Response` export type ([e63919b](https://github.com/h3dev/srvx/commit/e63919b))
- **node:** Use `headers.entries` when full Headers is set as init ([7f8cac8](https://github.com/h3dev/srvx/commit/7f8cac8))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.1

[compare changes](https://github.com/h3dev/srvx/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- **node:** Export `toNodeHandler` ([5df69b6](https://github.com/h3dev/srvx/commit/5df69b6))
- Export handler types ([54a01e4](https://github.com/h3dev/srvx/commit/54a01e4))

### 🏡 Chore

- Apply automated updates ([5a1caf0](https://github.com/h3dev/srvx/commit/5a1caf0))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.0

[compare changes](https://github.com/h3dev/srvx/compare/v0.1.4...v0.2.0)

### 🚀 Enhancements

- Initial cloudflare support ([cab127c](https://github.com/h3dev/srvx/commit/cab127c))
- Expose `server.node.handler` ([c84d604](https://github.com/h3dev/srvx/commit/c84d604))
- `manual` mode ([ef6f9ed](https://github.com/h3dev/srvx/commit/ef6f9ed))

### 💅 Refactors

- ⚠️ Update exports ([7153090](https://github.com/h3dev/srvx/commit/7153090))
- ⚠️ Overhaul internal implementation ([d444c74](https://github.com/h3dev/srvx/commit/d444c74))

### 📦 Build

- Remove extra files ([0f655b1](https://github.com/h3dev/srvx/commit/0f655b1))

### 🏡 Chore

- Update deps ([0b8494a](https://github.com/h3dev/srvx/commit/0b8494a))
- Update ci ([4b59db0](https://github.com/h3dev/srvx/commit/4b59db0))
- Apply automated updates ([06d094c](https://github.com/h3dev/srvx/commit/06d094c))
- Apply automated updates ([0dc2044](https://github.com/h3dev/srvx/commit/0dc2044))

### ✅ Tests

- Fix coverage report ([1f8ba79](https://github.com/h3dev/srvx/commit/1f8ba79))

### 🤖 CI

- Update to node 22 ([2e3044e](https://github.com/h3dev/srvx/commit/2e3044e))

#### ⚠️ Breaking Changes

- ⚠️ Update exports ([7153090](https://github.com/h3dev/srvx/commit/7153090))
- ⚠️ Overhaul internal implementation ([d444c74](https://github.com/h3dev/srvx/commit/d444c74))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.4

[compare changes](https://github.com/h3dev/srvx/compare/v0.1.3...v0.1.4)

### 🩹 Fixes

- **node:** Access req headers with lowerCase ([#21](https://github.com/h3dev/srvx/pull/21))

### 💅 Refactors

- **node:** Improve body streaming ([#26](https://github.com/h3dev/srvx/pull/26))

### 🏡 Chore

- Update deps ([b74f68a](https://github.com/h3dev/srvx/commit/b74f68a))
- Lint ([011d381](https://github.com/h3dev/srvx/commit/011d381))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Alex ([@alexfriesen](http://github.com/alexfriesen))

## v0.1.3

[compare changes](https://github.com/h3dev/srvx/compare/v0.1.1...v0.1.3)

### 🚀 Enhancements

- **node:** Add `NodeFastResponse.bytes()` ([#16](https://github.com/h3dev/srvx/pull/16))
- **node:** Add `NodeRequestProxy.bytes()` ([07863f6](https://github.com/h3dev/srvx/commit/07863f6))

### 🩹 Fixes

- **node:** Compute `hasBody` when accessing `req.body` ([a002185](https://github.com/h3dev/srvx/commit/a002185))
- **node:** Body utils should respect buffer view offset ([5e4ec69](https://github.com/h3dev/srvx/commit/5e4ec69))

### 💅 Refactors

- **node:** Expose `request._url` ([8eb8f5d](https://github.com/h3dev/srvx/commit/8eb8f5d))

### 📖 Documentation

- Minor tweaks ([#9](https://github.com/h3dev/srvx/pull/9))

### 🏡 Chore

- Apply automated updates ([7def381](https://github.com/h3dev/srvx/commit/7def381))
- Update dev dependencies ([5bc0dce](https://github.com/h3dev/srvx/commit/5bc0dce))
- **release:** V0.1.2 ([4bf7261](https://github.com/h3dev/srvx/commit/4bf7261))

### ✅ Tests

- Update ip regex ([6885842](https://github.com/h3dev/srvx/commit/6885842))
- Add additional tests for req body handling ([e00b4c9](https://github.com/h3dev/srvx/commit/e00b4c9))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Emil ([@bergold](http://github.com/bergold))
- Johann Schopplich ([@johannschopplich](http://github.com/johannschopplich))

## v0.1.2

[compare changes](https://github.com/h3dev/srvx/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **node:** Add `NodeFastResponse.bytes()` ([#16](https://github.com/h3dev/srvx/pull/16))
- **node:** Add `NodeRequestProxy.bytes()` ([07863f6](https://github.com/h3dev/srvx/commit/07863f6))

### 📖 Documentation

- Minor tweaks ([#9](https://github.com/h3dev/srvx/pull/9))

### 🏡 Chore

- Apply automated updates ([7def381](https://github.com/h3dev/srvx/commit/7def381))
- Update dev dependencies ([5bc0dce](https://github.com/h3dev/srvx/commit/5bc0dce))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Emil ([@bergold](http://github.com/bergold))
- Johann Schopplich ([@johannschopplich](http://github.com/johannschopplich))

## v0.1.1

### 🚀 Enhancements

- Plugin support ([53874f0](https://github.com/h3dev/srvx/commit/53874f0))

### 🩹 Fixes

- **node:** Send body with `NodeFastResponse` ([ac689ef](https://github.com/h3dev/srvx/commit/ac689ef))

### 💅 Refactors

- Update deno types ([9598308](https://github.com/h3dev/srvx/commit/9598308))

### 📖 Documentation

- Remove extra `await` ([#2](https://github.com/h3dev/srvx/pull/2))
- Update diff explainer ([fbd81af](https://github.com/h3dev/srvx/commit/fbd81af))

### 🏡 Chore

- Small fixes ([592b97c](https://github.com/h3dev/srvx/commit/592b97c))
- Update undocs ([45613b7](https://github.com/h3dev/srvx/commit/45613b7))
- Update docs ([2b0d96b](https://github.com/h3dev/srvx/commit/2b0d96b))
- Update deps ([4eb6a8c](https://github.com/h3dev/srvx/commit/4eb6a8c))
- Update docs ([768075d](https://github.com/h3dev/srvx/commit/768075d))
- Fix types ([1bd4a38](https://github.com/h3dev/srvx/commit/1bd4a38))
- Apply automated updates ([98e7af7](https://github.com/h3dev/srvx/commit/98e7af7))
- Bump to 0.1.0 ([59fa1db](https://github.com/h3dev/srvx/commit/59fa1db))
- Update playground ([fa1a776](https://github.com/h3dev/srvx/commit/fa1a776))
- Update playground ([98eb941](https://github.com/h3dev/srvx/commit/98eb941))
- Fix readme ([00e3f7d](https://github.com/h3dev/srvx/commit/00e3f7d))
- **playground:** Set charset in content-type header ([#4](https://github.com/h3dev/srvx/pull/4))
- Fix typo ([#5](https://github.com/h3dev/srvx/pull/5))

### 🤖 CI

- Update deno to v2 ([2e2245b](https://github.com/h3dev/srvx/commit/2e2245b))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Andrei Luca ([@iamandrewluca](http://github.com/iamandrewluca))
- Florens Verschelde ([@fvsch](http://github.com/fvsch))
- Sébastien Chopin <seb@nuxtlabs.com>
