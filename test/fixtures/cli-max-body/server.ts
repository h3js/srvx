// CLI fixture: calls serve() with an inline `maxRequestBodySize`. Under the CLI
// loader this call is intercepted before it listens, so the limit lives only on
// the intercepted inner server — the loader must thread it onto the outer server
// (F27). Echoes the body, or the error code/status on overflow.
import { serve } from "srvx";

serve({
  maxRequestBodySize: 8,
  fetch: async (req: Request) => {
    try {
      return new Response(await req.text());
    } catch (error: any) {
      return new Response(error.code ?? "ERR", { status: error.statusCode ?? 500 });
    }
  },
});
