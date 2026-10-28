/**
 * Joins an assistant turn's text parts into one string.
 *
 * A tool-using turn carries one text part per model call (text → tool →
 * text), and neither the live stream nor stored history ends a part with
 * whitespace. Joining them with `''` glued the sentences together ("…on
 * screen.I can't…"), so a paragraph break goes between two parts unless one
 * side of the seam already has whitespace.
 */
export function joinTextParts(texts: readonly string[]): string {
  let out = '';
  for (const text of texts) {
    if (!text) continue;
    if (out && !/\s$/.test(out) && !/^\s/.test(text)) out += '\n\n';
    out += text;
  }
  return out;
}
