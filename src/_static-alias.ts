// An 8.3 short-name segment (`ADMINI~1`, `LONGFI~1.TXT`): a base of at most six
// characters, `~` and a number, then an extension of at most three.
const SHORT_NAME_RE = /(?:^|\\)[^.\\]{1,6}~\d+(?:\.[^.\\]{1,3})?(?:\\|$)/;

/**
 * Whether `real`, a served file's root-relative path as `realpath()` reports it,
 * is another spelling of `lex`, the root-relative path the request named,
 * rather than where a symlink led. The last `suffixLength` characters of `lex`
 * were appended by the middleware (`index.html`, `.html`, a variant's `.br`),
 * not taken from the URL, so their case is not checked. A case-only symlink
 * on a case-sensitive filesystem also yields a flagged pair; the caller tells
 * it apart with `departingPrefix`.
 *
 * On a case-insensitive filesystem (default macOS, Windows) `/ADMIN/x.txt`
 * opens `admin/x.txt`: a second URL for the file, which also gets past an
 * earlier `startsWith("/admin")` check in the app, like the encoded spellings
 * `NON_CANONICAL_PATH_RE` refuses. The native `realpath()` returns the name
 * stored on disk on both (macOS `realpath(3)`, Windows
 * `GetFinalPathNameByHandleW`), so a `real` that differs from `lex` only by
 * letter case marks the alias. Any other difference means a symlink was
 * followed, and in-root links are served.
 *
 * - A difference in Unicode normalization alone is tolerated when the request
 *   is already NFC: HFS+ stores (and `realpath()` returns) every name
 *   decomposed, while browsers send composed URLs. A request that is not NFC
 *   must match the disk exactly, or it could reach a name through a singleton
 *   such as U+212A KELVIN SIGN, which NFC maps to `K`.
 * - On Windows an 8.3 short name (`ADMINI~1`) is the same kind of alias, and
 *   `realpath()` expands it to the long name, so a path with a short-name
 *   segment is refused when it resolves elsewhere, unless that segment is
 *   itself a symlink (`v~1.txt` -> `sub/x.txt`).
 *
 * Not caught: a miscased segment that a followed symlink renames away
 * (`/LINK.txt` for `link.txt` -> `x.txt`), as `real` then differs in more than
 * case; the rare characters a filesystem's own case table folds differently
 * from `toLowerCase()`; and any case-insensitive mount on Linux (casefold,
 * vfat/exFAT, SMB, WSL `/mnt/c`), where glibc `realpath(3)` returns the
 * spelling it was given, so `real` always equals `lex`.
 */
export function isSpellingAlias(
  real: string,
  lex: string,
  suffixLength: number,
  sep: string,
): boolean {
  if (real === lex) {
    return false;
  }
  if (suffixLength > 0) {
    // The suffix is ASCII, so a case-only difference keeps its length.
    const realSuffix = real.slice(-suffixLength);
    if (realSuffix.toLowerCase() !== lex.slice(-suffixLength).toLowerCase()) {
      return false; // renamed by a symlink
    }
    real = real.slice(0, -suffixLength);
    lex = lex.slice(0, -suffixLength);
  }
  const r = real.normalize("NFC");
  const l = lex.normalize("NFC");
  if (r === l && l === lex) {
    return false; // normalization only, from a composed request
  }
  return r.toLowerCase() === l.toLowerCase() || (sep === "\\" && SHORT_NAME_RE.test(lex));
}

/**
 * `lex` up to and including its first segment that differs from the same
 * segment of `real`, or `undefined` when no segment of `lex` does.
 */
export function departingPrefix(real: string, lex: string, sep: string): string | undefined {
  const lexSegments = lex.split(sep);
  const realSegments = real.split(sep);
  for (let i = 0; i < lexSegments.length; i++) {
    if (lexSegments[i] !== realSegments[i]) {
      return lexSegments.slice(0, i + 1).join(sep);
    }
  }
  return undefined;
}
