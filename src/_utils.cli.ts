// Colors support for terminal output
const noColor =
  globalThis.process?.env?.NO_COLOR === "1" ||
  globalThis.process?.env?.TERM === "dumb";
const _c = (c: number) => (t: string) =>
  noColor ? t : `\u001B[${c}m${t}\u001B[0m`;

export const Colors = {
  bold: _c(1),
  red: _c(31),
  green: _c(32),
  yellow: _c(33),
  blue: _c(34),
  magenta: _c(35),
  cyan: _c(36),
  gray: _c(90),
  url: (title: string, url: string) =>
    noColor
      ? `[${title}](${url})`
      : `\u001B]8;;${url}\u001B\\${title}\u001B]8;;\u001B\\`,
} as Record<
  | "bold"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "gray"
  | "url",
  (text: string) => string
> & {
  url: (title: string, url: string) => string;
};
