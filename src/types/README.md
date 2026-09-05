# Runtime types

Minimal type declarations for the runtime objects srvx exposes, one file per runtime.

srvx does **not** import `@types/bun`, `@types/deno`, `@cloudflare/workers-types`,
`@types/aws-lambda` or `@types/serviceworker` from its sources. Those packages are not
shipped to consumers, and several of them redeclare the same globals so they cannot be
installed side by side. Referencing them from the published declarations made `tsc` fail
for anyone targeting a single runtime without `skipLibCheck`
([#284](https://github.com/h3js/srvx/issues/284)).

Each type covers only what srvx itself reads or forwards, and stays structurally
compatible with the official one, so a real `Bun.Server`, `Deno.HttpServer` or Lambda
event is still accepted where srvx expects one. Consumers cast to the official type when
they need the full surface.

The official packages stay as devDependencies: `types.d.ts` references the `Deno`, `Bun`
and service worker globals so the adapter implementations are still checked against the
real declarations, and `test/aws.test.ts` feeds real `aws-lambda` events through the
handlers. That is what keeps these shims honest. An oxlint `no-restricted-imports`
override on `src/**` prevents the packages from being imported again.
