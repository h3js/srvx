// Fixture server for CLI tests.
export const fetch = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname === "/bad") {
    return new Response("bad", { status: 404 });
  }
  if (url.pathname === "/echo") {
    return new Response(await req.text());
  }
  if (url.pathname === "/boom") {
    // Used to assert that the verbose error page (which embeds the stack)
    // is only rendered in dev mode.
    throw new Error("BOOM_SECRET");
  }
  if (url.pathname === "/env") {
    return new Response(process.env.CLI_TEST_VAR || "");
  }
  return new Response("ok");
};
