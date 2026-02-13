export default {
  // https://srvx.h3.dev/guide/options
  fetch(req: Request) {
    const url = new URL(req.url);

    // Serve static files
    if (url.pathname.startsWith("/public/")) {
      return new Response(null, { status: 404 });
    }

    // API endpoint example
    if (url.pathname === "/api/info") {
      return Response.json({
        runtime: "bunny",
        message: "Running on Bunny Edge Network!",
        ip: req.ip,
        headers: Object.fromEntries(req.headers.entries()),
      });
    }

    // Default response
    return new Response(
      `
<!DOCTYPE html>
<html>
  <head>
    <title>srvx on Bunny Edge</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        max-width: 800px;
        margin: 40px auto;
        padding: 20px;
        line-height: 1.6;
      }
      .badge {
        background: #ff4088;
        color: white;
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 14px;
      }
      pre {
        background: #f5f5f5;
        padding: 16px;
        border-radius: 8px;
        overflow-x: auto;
      }
    </style>
  </head>
  <body>
    <h1>🐰 srvx on <span class="badge">Bunny Edge</span></h1>
    <p>This example demonstrates srvx running on the Bunny Edge Network.</p>

    <h2>Try it out:</h2>
    <ul>
      <li><a href="/api/info">GET /api/info</a> - View request information</li>
      <li>Your IP: <code>${req.ip || "unknown"}</code></li>
    </ul>

    <h2>Code Example:</h2>
    <pre><code>export default {
  fetch(req: Request) {
    return Response.json({
      message: "Hello from Bunny Edge!"
    });
  },
};</code></pre>
  </body>
</html>
      `.trim(),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  },
};
