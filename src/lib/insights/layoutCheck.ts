/**
 * Layout check for insight HTML: flags a page-level container whose height is
 * capped while its vertical overflow is clipped or scrolled.
 *
 * The host frame grows to fit the whole document (see `srcdoc.ts`), so a page
 * container never needs to scroll. Give it `aspect-ratio: 16/9`, a `vh` or px
 * `height`/`max-height`, and `overflow: auto|hidden`, and whatever runs past
 * the box is clipped or trapped in an inner scroller the user rarely notices —
 * macOS hides the scrollbar until you scroll.
 *
 * Advisory only: the tools append the warning to a successful write rather
 * than refusing it, so an insight that already carries the pattern can still
 * take a section edit (which cannot reach its `<style>`) or a scheduled refresh.
 *
 * Deliberately narrow, so a real inner scroller never trips it: only `html`,
 * `body` and body's top-level elements (following a single-child wrapper chain)
 * count, and `aspect-ratio` or `min-height` without overflow is fine — the box
 * then grows past its ratio when the content is taller.
 */

import { NodeType, type HTMLElement } from 'node-html-parser';
import { isTooDeeplyNested, parseInsightHtml } from '@/lib/insights/parseHtml';
import type { CandidateAudience } from '@/lib/insights/structuralCheck';

/** Elements that never render a box, so they don't count as page content. */
const NON_RENDERED_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta']);

/** Vertical overflow values that stop a box growing with its content. */
const CLIPPING_OVERFLOW = new Set(['auto', 'hidden', 'scroll', 'clip']);

/** A viewport or pixel length: `100vh`, `calc(100dvh - 40px)`, `720px`. */
const FIXED_LENGTH_RE = /\d(?:\.\d+)?(?:vh|dvh|svh|lvh|px)\b/i;
/** A percentage length, which caps the box only on `html`/`body`, where it
 *  resolves against the viewport. */
const PERCENT_LENGTH_RE = /\d(?:\.\d+)?%/;

/** `tag`, `.class`, `#id`, or a compound of them — nothing we cannot match. */
const COMPOUND_RE = /^(\*|[a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)$/i;

/** Opens every layout warning, so a test (or the agent) can tell it apart. */
export const INSIGHT_LAYOUT_WARNING_LEAD = 'Layout warning';

interface CssRule {
  selectors: string[];
  declarations: Map<string, string>;
}

interface PageElement {
  node: HTMLElement;
  tag: string;
  label: string;
}

interface Computed {
  label: string;
  props: Map<string, string>;
  isRoot: boolean;
}

/**
 * Returns a warning naming each page-level container that caps its height and
 * clips its overflow, or null when the layout lets the page grow.
 */
export function checkInsightLayout(html: string): string | null {
  if (!html) return null;
  const root = parseInsightHtml(html, { comment: false });
  // Too deep to walk; the write path refuses it with its own message.
  if (isTooDeeplyNested(root)) return null;
  const elements = pageLevelElements(root);
  if (elements.length === 0) return null;

  const computed = new Map<HTMLElement, Computed>(
    elements.map((el) => [
      el.node,
      { label: el.label, props: new Map(), isRoot: el.tag === 'html' || el.tag === 'body' },
    ]),
  );

  // Source order, last wins — specificity and media conditions are ignored,
  // which errs towards flagging a rule that only applies on some screens.
  for (const style of root.querySelectorAll('style')) {
    for (const rule of parseCss(style.text)) {
      for (const el of elements) {
        if (rule.selectors.some((s) => selectorTargets(s, el))) {
          const props = computed.get(el.node)!.props;
          rule.declarations.forEach((value, prop) => props.set(prop, value));
        }
      }
    }
  }
  for (const el of elements) {
    const inline = el.node.getAttribute('style');
    if (!inline) continue;
    const props = computed.get(el.node)!.props;
    parseDeclarations(inline).forEach((value, prop) => props.set(prop, value));
  }

  const offenders = [...computed.values()].filter(isTrapped).map((c) => c.label);
  if (offenders.length === 0) return null;

  const names = [...new Set(offenders)];
  const list = names.map((l) => `\`${l}\``).join(', ');
  const subject =
    names.length === 1
      ? `${list} is a page-level container that caps its height`
      : `${list} are page-level containers that cap their height`;
  return (
    `${INSIGHT_LAYOUT_WARNING_LEAD}: ${subject} (a fixed/vh height, max-height or aspect-ratio) ` +
    `AND clip${names.length === 1 ? 's' : ''} vertical overflow (overflow auto/hidden/scroll). ` +
    `The insight frame already grows to fit the whole document, ` +
    `so anything taller than that box is cut off or trapped in an inner scroller the user will not ` +
    `see. Remove the overflow from that container — keep aspect-ratio (or use min-height) if a ` +
    `slide-like 16:9 look is wanted; without overflow the box grows past it when the content is taller.`
  );
}

/**
 * The layout warning to append to a successful write, with what the agent
 * should do next, or null when there is nothing to say.
 *
 * `previousHtml` is the document before a section edit: a section fragment
 * cannot reach the page's `<style>`, so the warning fires only when the edit
 * itself introduced the pattern — otherwise every edit of an insight that
 * already has it would nag the agent into rewriting the whole document.
 */
export function insightLayoutNote(
  html: string,
  audience: CandidateAudience,
  previousHtml?: string,
): string | null {
  const warning = checkInsightLayout(html);
  if (!warning) return null;
  if (audience === 'workforce-section' && previousHtml !== undefined && checkInsightLayout(previousHtml)) {
    return null;
  }

  switch (audience) {
    case 'create-proposal':
    case 'edit-proposal':
      return `${warning} The approval card was still offered. Propose a corrected version without that overflow now, in this turn, so the user approves the fixed one.`;
    case 'workforce-create':
    case 'workforce-document':
      return `${warning} This write went through. Fix it with replace_insight_document before you finish.`;
    case 'workforce-section':
      return `${warning} This write went through. The container's CSS is outside this section, so fix it with replace_insight_document before you finish.`;
  }
}

/** `html`, `body`, and body's top-level rendered elements, following any
 *  single-child wrapper chain (`body > main > div.deck`). */
function pageLevelElements(root: HTMLElement): PageElement[] {
  const out: PageElement[] = [];
  const htmlEl = root.querySelector('html');
  const bodyEl = root.querySelector('body');
  if (htmlEl) out.push(describeElement(htmlEl));
  if (bodyEl) out.push(describeElement(bodyEl));

  let level = renderedChildren(bodyEl ?? root);
  while (level.length > 0) {
    // A loop, not push(...spread): a page with hundreds of thousands of
    // top-level elements exceeds the engine's argument limit.
    for (const el of level) out.push(describeElement(el));
    level = level.length === 1 ? renderedChildren(level[0]) : [];
  }
  return out;
}

function renderedChildren(node: HTMLElement): HTMLElement[] {
  return node.childNodes.filter(
    (child): child is HTMLElement =>
      child.nodeType === NodeType.ELEMENT_NODE &&
      !NON_RENDERED_TAGS.has((child as HTMLElement).tagName?.toLowerCase() ?? ''),
  );
}

function describeElement(node: HTMLElement): PageElement {
  const tag = node.tagName.toLowerCase();
  const id = node.getAttribute('id');
  const cls = (node.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
  const label = id ? `#${id}` : cls ? `.${cls}` : tag;
  return { node, tag, label };
}

/** Whether the rightmost compound of `selector` matches `el`. Pseudo-classes,
 *  attribute selectors and anything else we cannot evaluate never match,
 *  except `:root`, which is `html`. */
function selectorTargets(selector: string, el: PageElement): boolean {
  const compound = selector.trim().split(/\s*[\s>+~]\s*/).pop() ?? '';
  if (compound === ':root' || compound === 'html:root') return el.tag === 'html';
  const m = COMPOUND_RE.exec(compound);
  if (!m || compound === '') return false;
  const [, tag, rest] = m;
  if (tag && tag !== '*' && tag.toLowerCase() !== el.tag) return false;

  const classes = new Set(
    (el.node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
  );
  const id = el.node.getAttribute('id');
  for (const part of rest.match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.' && !classes.has(part.slice(1))) return false;
    if (part[0] === '#' && part.slice(1) !== id) return false;
  }
  return Boolean(tag || rest);
}

function isTrapped({ props, isRoot }: Computed): boolean {
  const capsHeight =
    ['height', 'max-height'].some((p) => {
      const v = props.get(p);
      return !!v && (FIXED_LENGTH_RE.test(v) || (isRoot && PERCENT_LENGTH_RE.test(v)));
    }) ||
    (!!props.get('aspect-ratio') && props.get('aspect-ratio') !== 'auto');
  return capsHeight && CLIPPING_OVERFLOW.has(overflowY(props));
}

/** The effective `overflow-y`: the longhand, else the shorthand's second value
 *  (or its only value). */
function overflowY(props: Map<string, string>): string {
  const longhand = props.get('overflow-y');
  if (longhand) return longhand;
  const parts = (props.get('overflow') ?? '').split(/\s+/).filter(Boolean);
  return parts[1] ?? parts[0] ?? '';
}

/** Style rules in source order, descending into grouping at-rules (`@media`,
 *  `@supports`, `@container`, `@layer`) and skipping the rest (`@keyframes`,
 *  `@font-face`, …), whose blocks are not element rules. */
function parseCss(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const prelude = text.slice(i, open).trim();
    const close = matchingBrace(text, open);
    const body = text.slice(open + 1, close === -1 ? text.length : close);
    i = close === -1 ? text.length : close + 1;

    // A statement at-rule (`@import …;`) before this block belongs to no rule.
    const head = prelude.slice(prelude.lastIndexOf(';') + 1).trim();
    if (head.startsWith('@')) {
      if (/^@(media|supports|container|layer|document)\b/i.test(head)) {
        for (const rule of parseCss(body)) rules.push(rule);
      }
      continue;
    }
    rules.push({
      selectors: head.split(',').map((s) => s.trim()).filter(Boolean),
      declarations: parseDeclarations(body),
    });
  }
  return rules;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return j;
  }
  return -1;
}

function parseDeclarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of block.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
      .toLowerCase();
    if (prop && value) out.set(prop, value);
  }
  return out;
}
