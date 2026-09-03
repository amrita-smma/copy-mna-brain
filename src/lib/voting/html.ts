import { parse, HTMLElement, NodeType, type Node } from 'node-html-parser';

/**
 * Tags the ballot editor can produce, and the only ones we persist. Everything
 * else is unwrapped (children kept, tag dropped) rather than deleted, so a
 * paste from Word still keeps its text.
 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'span',
  'h1',
  'h2',
  'h3',
  'blockquote',
  'code',
  'pre',
  'a',
]);

/** Tags whose content is script-ish — dropped entirely, children included. */
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);

/**
 * Inline style declarations we keep. `font-size` backs the editor's font-size
 * control; `margin-left` backs Tab indentation on paragraphs. Anything else
 * (positioning, background images, …) is stripped.
 */
const ALLOWED_STYLE_PROPS = new Set(['font-size', 'margin-left', 'text-align']);

const CSS_LENGTH = /^-?\d+(\.\d+)?(px|pt|rem|em|%)$/;
const CSS_ALIGN = /^(left|center|right|justify)$/;

function sanitizeStyle(raw: string): string | null {
  const kept: string[] = [];
  for (const decl of raw.split(';')) {
    const [rawProp, ...rest] = decl.split(':');
    if (!rawProp || rest.length === 0) continue;
    const prop = rawProp.trim().toLowerCase();
    const value = rest.join(':').trim().toLowerCase();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (prop === 'text-align' ? !CSS_ALIGN.test(value) : !CSS_LENGTH.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.length ? kept.join('; ') : null;
}

/** Only http(s) and mailto links survive — no `javascript:` / `data:` URLs. */
function sanitizeHref(raw: string): string | null {
  const value = raw.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

function sanitizeNode(node: Node): void {
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase() ?? '';

  // Snapshot children first: unwrapping mutates the parent's child list.
  const children = [...el.childNodes];

  if (DROPPED_TAGS.has(tag)) {
    el.remove();
    return;
  }

  for (const child of children) sanitizeNode(child);

  if (!ALLOWED_TAGS.has(tag)) {
    // Unwrap: replace the element with its (already sanitized) inner HTML.
    el.replaceWith(el.innerHTML);
    return;
  }

  for (const attr of Object.keys(el.attributes)) {
    const lower = attr.toLowerCase();
    if (lower === 'style') {
      const style = sanitizeStyle(el.getAttribute(attr) ?? '');
      el.removeAttribute(attr);
      if (style) el.setAttribute('style', style);
      continue;
    }
    if (lower === 'href' && tag === 'a') {
      const href = sanitizeHref(el.getAttribute(attr) ?? '');
      el.removeAttribute(attr);
      if (href) {
        el.setAttribute('href', href);
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      continue;
    }
    if (lower === 'rel' || lower === 'target') continue;
    el.removeAttribute(attr);
  }
}

/**
 * Sanitize the ballot body coming from the WYSIWYG editor.
 *
 * The rationale is rendered back into other people's browsers once a vote
 * concludes, so it MUST NOT be trusted: this drops scripts/embeds, unwraps any
 * unexpected tag, and allows only the handful of inline styles the editor's own
 * toolbar can produce. Returns `null` for an empty/blank body so "no rationale
 * written" is a single representation in the DB.
 */
export function sanitizeBallotHtml(input: string | null | undefined): string | null {
  if (!input) return null;
  const root = parse(input, { comment: false });
  for (const child of [...root.childNodes]) sanitizeNode(child);
  const html = root.innerHTML.trim();
  if (!html) return null;
  // An editor with nothing typed still emits `<p></p>`. Treat a body with no
  // text and no line break as empty so "nothing written" has one DB shape.
  const hasContent = htmlToPlainText(html).length > 0 || /<br\b/i.test(html);
  return hasContent ? html : null;
}

/** Tags that start their own line when flattened to text. */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'li', 'div']);
/** Tags that only group blocks — recursed into, never rendered themselves. */
const CONTAINER_TAGS = new Set(['ul', 'ol']);

/**
 * Flatten ballot HTML to readable plain text — used for the AI synthesis prompt
 * and the plain-text half of the recap email. Each block tag becomes its own
 * line and `<li>` is prefixed with a bullet.
 */
export function htmlToPlainText(input: string | null | undefined): string {
  if (!input) return '';
  const root = parse(input, { comment: false });
  const lines: string[] = [];

  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

  const walk = (node: Node): void => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = collapse(node.text);
      if (text) lines.push(text);
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? '';
    if (DROPPED_TAGS.has(tag)) return;
    if (tag === 'br') {
      lines.push('');
      return;
    }
    if (CONTAINER_TAGS.has(tag)) {
      for (const child of el.childNodes) walk(child);
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      // A list item can itself hold a nested list — pull the nested items out
      // first so they stay on their own lines instead of collapsing into one.
      const nested = el.querySelectorAll('ul, ol');
      if (nested.length > 0) {
        for (const child of el.childNodes) walk(child);
        return;
      }
      const text = collapse(el.text);
      if (text) lines.push(tag === 'li' ? `- ${text}` : text);
      return;
    }
    // Inline (strong/em/span/a/…) — fold into whatever line we are building.
    const text = collapse(el.text);
    if (text) lines.push(text);
  };

  for (const child of root.childNodes) walk(child);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
