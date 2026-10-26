/**
 * The assistant sometimes answers with a raw HTML anchor —
 * `<a href="https://…">Acme</a>` — instead of a markdown link. The chat
 * renders markdown with raw HTML disabled (react-markdown escapes it), so the
 * tag reaches the bubble as literal `<a href=…>` text instead of a link.
 *
 * Rather than enabling raw HTML for the whole transcript, rewrite just the
 * anchors into markdown links before parsing. The existing link renderer
 * then draws them exactly like any other link (citation pills, click
 * telemetry, new-tab target). Only safe destinations survive: an anchor to
 * a `javascript:` or `data:` URL is reduced to its text.
 */

const ANCHOR =
  /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
// Fenced code blocks and inline code spans are left exactly as written.
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#|\.{0,2}\/)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function anchorToMarkdown(attrs: string, inner: string): string {
  const match = HREF.exec(attrs);
  const href = decodeEntities((match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim());
  const text = inner.trim();

  if (
    !href ||
    href.startsWith('//') ||
    /[\s\x00-\x1f\x7f<>]/.test(href) ||
    !SAFE_HREF.test(href)
  ) {
    return text;
  }
  // A destination in angle brackets may contain spaces or parentheses, so
  // the href needs no escaping; `>` can't occur in it (it ended the tag).
  const label = (text || href).replace(/([\[\]])/g, '\\$1');
  return `[${label}](<${href}>)`;
}

/**
 * Rewrite every raw `<a href="…">…</a>` in `content` as a markdown link.
 * Text with no anchor is returned as-is (same string instance).
 */
export function htmlAnchorsToMarkdown(content: string): string {
  if (!/<a\b/i.test(content)) return content;
  return content
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(ANCHOR, (_m, attrs: string, inner: string) => anchorToMarkdown(attrs, inner)),
    )
    .join('');
}
