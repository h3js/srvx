// Fixture: an entry that starts its *own* TLS (optionally mutual-TLS) server by
// calling srvx's `serve()` at import time — the pattern documented in
// docs/1.guide/06.tls.md. The CLI's loader intercepts that call, so this fixture
// pins that the CLI forwards the intercepted server's `tls`/`node` options to its
// own listener instead of silently serving the handler over plaintext HTTP.
//
// Configured through env vars so one fixture covers both the plain-TLS and the
// mutual-TLS cases (see the "serve mode: entry TLS" block in test/cli.test.ts).
import { serve } from "../../../src/adapters/node.ts";
import { mtlsPlugin } from "../../../src/mtls.ts";
import type { ServerPlugin } from "../../../src/types.ts";

const env = process.env;

const plugins: ServerPlugin[] = env.SRVX_TEST_CA
  ? [
      mtlsPlugin({
        ca: env.SRVX_TEST_CA,
        requestCert: true,
        rejectUnauthorized: env.SRVX_TEST_REJECT_UNAUTHORIZED !== "false",
      }),
    ]
  : [];

serve({
  // Must be ignored: the CLI owns port/hostname.
  port: 1,
  tls: { cert: env.SRVX_TEST_CERT!, key: env.SRVX_TEST_KEY! },
  plugins,
  // Counts how often the entry's own middleware runs for a single request. The
  // CLI must not re-apply `middleware`/`plugins`: they are already folded into
  // the intercepted server's composed `fetch`.
  middleware: [
    (request, next) => {
      const req = request as unknown as { __mwCount?: number };
      req.__mwCount = (req.__mwCount || 0) + 1;
      return next();
    },
  ],
  fetch: (request) =>
    Response.json({
      ok: true,
      mwCount: (request as unknown as { __mwCount?: number }).__mwCount || 0,
      authorized: request.tls?.authorized ?? null,
      subjectCN: request.tls?.peerCertificate?.subject?.CN ?? null,
    }),
});
