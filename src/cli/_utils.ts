// Colors support for terminal output
// F58: honor the NO_COLOR convention (ANY non-empty value disables) and only
// emit escape sequences to an interactive TTY (unless FORCE_COLOR is set).
const noColor = /* @__PURE__ */ (() => {
  const proc = globalThis.process;
  const env = proc?.env ?? {};
  if (env.FORCE_COLOR) {
    return false;
  }
  if (env.NO_COLOR || env.TERM === "dumb") {
    return true;
  }
  return !proc?.stdout?.isTTY;
})();

const _c =
  (c: number, r: number = 39) =>
  (t: string) =>
    noColor ? t : `\u001B[${c}m${t}\u001B[${r}m`;

type ColorType = (text: string) => string;

export const bold: ColorType = /* @__PURE__ */ _c(1, 22);
export const red: ColorType = /* @__PURE__ */ _c(31);
export const green: ColorType = /* @__PURE__ */ _c(32);
export const yellow: ColorType = /* @__PURE__ */ _c(33);
export const blue: ColorType = /* @__PURE__ */ _c(34);
export const magenta: ColorType = /* @__PURE__ */ _c(35);
export const cyan: ColorType = /* @__PURE__ */ _c(36);
export const gray: ColorType = /* @__PURE__ */ _c(90);

export const url: (title: string, url: string) => string = (title, url) =>
  noColor ? `[${title}](${url})` : `\u001B]8;;${url}\u001B\\${title}\u001B]8;;\u001B\\`;
