import pkg from "../../package.json" with { type: "json" };

export const srvxMeta = {
  name: pkg.name as string,
  version: pkg.version as string,
  description: pkg.description as string,
};
