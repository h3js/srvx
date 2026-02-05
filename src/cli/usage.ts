import * as c from "./_utils.ts";
import type { MainOptions } from "./types.ts";

export function usage(mainOpts: MainOptions): string {
  const command = mainOpts.usage?.command || "srvx";

  const name = mainOpts.meta?.name || command;
  const ver = mainOpts.meta?.version || "";
  const desc = mainOpts.meta?.description;

  return `
${c.cyan(name)}${c.gray(`${ver ? ` ${ver}` : ""} ${desc ? `- ${desc}` : ""}`)}

${c.bold("SERVE MODE")}

${c.bold(c.green(`# ${command} serve [options]`))}
${c.gray("$")} ${c.cyan(command)} serve --entry ${c.gray("./server.ts")}    ${c.gray("# Start development server")}
${c.gray("$")} ${c.cyan(command)} serve --prod                 ${c.gray("# Start production  server")}
${c.gray("$")} ${c.cyan(command)} serve --port=8080            ${c.gray("# Listen on port 8080")}
${c.gray("$")} ${c.cyan(command)} serve --host=localhost       ${c.gray("# Bind to localhost only")}
${c.gray("$")} ${c.cyan(command)} serve --import=jiti/register ${c.gray(`# Enable ${c.url("jiti", "https://github.com/unjs/jiti")} loader`)}
${c.gray("$")} ${c.cyan(command)} serve --tls --cert=cert.pem --key=key.pem  ${c.gray("# Enable TLS (HTTPS/HTTP2)")}

${c.bold("FETCH MODE")}

${c.bold(c.green(`# ${command} fetch|curl [options] [url]`))}
${c.gray("$")} ${c.cyan(command)} fetch                  ${c.gray("# Fetch from default entry")}
${c.gray("$")} ${c.cyan(command)} fetch /api/users       ${c.gray("# Fetch a specific URL/path")}
${c.gray("$")} ${c.cyan(command)} fetch --entry ./server.ts /api/users ${c.gray("# Fetch using a specific entry")}
${c.gray("$")} ${c.cyan(command)} fetch -X POST /api/users ${c.gray("# POST request")}
${c.gray("$")} ${c.cyan(command)} fetch -H "Content-Type: application/json" /api ${c.gray("# With headers")}
${c.gray("$")} ${c.cyan(command)} fetch -d '{"name":"foo"}' /api ${c.gray("# With request body")}
${c.gray("$")} ${c.cyan(command)} fetch -v /api/users    ${c.gray("# Verbose output (show headers)")}
${c.gray("$")} echo '{"name":"foo"}' | ${c.cyan(command)} fetch -d @- /api ${c.gray("# Body from stdin")}

${c.bold("COMMON OPTIONS")}

  ${c.green("--entry")} ${c.yellow("<file>")}           Server entry file to use
  ${c.green("--dir")} ${c.yellow("<dir>")}              Working directory for resolving entry file
  ${c.green("-h, --help")}               Show this help message
  ${c.green("--version")}                Show server and runtime versions

${c.bold("SERVE OPTIONS")}

  ${c.green("-p, --port")} ${c.yellow("<port>")}        Port to listen on (default: ${c.yellow("3000")})
  ${c.green("--host")} ${c.yellow("<host>")}            Host to bind to (default: all interfaces)
  ${c.green("-s, --static")} ${c.yellow("<dir>")}       Serve static files from the specified directory (default: ${c.yellow("public")})
  ${c.green("--prod")}                   Run in production mode (no watch, no debug)
  ${c.green("--import")} ${c.yellow("<loader>")}        ES module to preload
  ${c.green("--tls")}                    Enable TLS (HTTPS/HTTP2)
  ${c.green("--cert")} ${c.yellow("<file>")}            TLS certificate file
  ${c.green("--key")}  ${c.yellow("<file>")}            TLS private key file

${c.bold("FETCH OPTIONS")}

  ${c.green("-X, --request")} ${c.yellow("<method>")}   HTTP method (default: ${c.yellow("GET")}, or ${c.yellow("POST")} if body is provided)
  ${c.green("-H, --header")} ${c.yellow("<header>")}    Add header (format: "Name: Value", can be used multiple times)
  ${c.green("-d, --data")} ${c.yellow("<data>")}        Request body (use ${c.yellow("@-")} for stdin, ${c.yellow("@file")} for file)
  ${c.green("-v, --verbose")}            Show request and response headers

${c.bold("ENVIRONMENT")}

  ${c.green("PORT")}                     Override port
  ${c.green("HOST")}                     Override host
  ${c.green("NODE_ENV")}                 Set to ${c.yellow("production")} for production mode.

${mainOpts.usage?.docs ? `➤ ${c.url("Documentation", mainOpts.usage.docs)}` : ""}
${mainOpts.usage?.issues ? `➤ ${c.url("Report issues", mainOpts.usage.issues)}` : ""}
`.trim();
}
