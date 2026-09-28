/**
 * The diff an insight edit card shows before the edit lands (MB-554): which
 * sections of the document changed, and which figures changed, with their
 * before and after values.
 *
 * An insight is one static, self-contained HTML document per version, with
 * every figure baked in as text. There is no structured model behind it, so
 * the diff is read from the two documents themselves:
 *
 * - **Sections.** A section is a block carrying `data-section="<key>"`,
 *   matched across versions by key. Blocks without a key fall back to their
 *   top-level order: unchanged ones are aligned by content (an LCS), and the
 *   leftovers between two aligned blocks are paired in order as "changed".
 *   Blocks are compared on their normalised visible text and structure:
 *   whitespace, attribute order, `class`, `style` and `<style>` blocks are
 *   ignored, so a restyle alone is not a content change.
 * - **Figures.** A figure is a number with its unit (currency, %, x,
 *   k/m/bn, …). Dates, years, source references (`[S1]`) and unavailable
 *   cells are not figures, and the Sources section is never read for them. A
 *   table cell is keyed by (row label = its row's first cell, column header),
 *   so a reordered row is not read as twenty changes; prose figures are
 *   aligned within their section and labelled with the nearest preceding
 *   words.
 * - **Carried over vs recomputed is not distinguished.** A recomputed figure
 *   that comes out the same is identical text; nothing in the HTML can tell
 *   the two apart.
 *
 * Pure, deterministic and browser-safe: it runs in the approval card, so it
 * uses its own small tokenizer rather than a DOM (none in the vitest node
 * environment) or `node-html-parser` (kept out of the client bundle). Bounded
 * for large documents: the figure list is capped at {@link MAX_FIGURE_CHANGES}
 * with the remainder counted.
 */

import { INSIGHT_SECTION_ATTR } from '@/lib/insights/srcdoc';
import { VOID_TAGS } from '@/lib/insights/htmlTags';
import {
  EVIDENCE_ATTR,
  SOURCE_REF_ATTR,
  SOURCES_SECTION_KEY,
} from '@/lib/agents/sector/evidenceMarkers';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SectionStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface SectionDiff {
  /** The block's `data-section` key, or null for a block without one. */
  key: string | null;
  /** The block's first heading, else a short excerpt of its text. */
  heading: string;
  status: SectionStatus;
  /**
   * Where the preview highlight is inserted in the AFTER document: the offset
   * just before its start tag's `>`. Only set for an added or changed block
   * that is a single element (not a bare text run, script or style).
   */
  anchor?: number;
}

export type FigureChangeKind = 'changed' | 'added' | 'removed';

export interface FigureChange {
  /** The `data-section` key of the section it sits in, or null. */
  sectionKey: string | null;
  /** That section's heading, for display. */
  sectionHeading: string;
  /** A table cell's "row · column", or the words before a prose figure. */
  label: string;
  before: string | null;
  after: string | null;
  kind: FigureChangeKind;
}

export interface InsightDiffSummary {
  sectionsChanged: number;
  sectionsAdded: number;
  sectionsRemoved: number;
  sectionsUnchanged: number;
  figuresChanged: number;
  figuresAdded: number;
  figuresRemoved: number;
  /** Figure changes beyond the cap, not in `figures`. */
  figuresOmitted: number;
  /** A script outside every section (typically a chart's data) changed. */
  scriptsChanged: boolean;
  /** Anything at all differs in content. */
  hasChanges: boolean;
}

export interface InsightVersionDiff {
  sections: SectionDiff[];
  figures: FigureChange[];
  summary: InsightDiffSummary;
}

/** The most figure changes listed; the rest are counted in `figuresOmitted`. */
export const MAX_FIGURE_CHANGES = 200;

/** Past this many cell comparisons an alignment falls back to plain order. */
const MAX_LCS_CELLS = 1_000_000;

// ---------------------------------------------------------------------------
// Tokenizer → a light tree
// ---------------------------------------------------------------------------

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Map<string, string>;
  children: HtmlNode[];
  /** Offset just before the start tag's `>` (or `/>`). */
  anchor: number;
}

interface TextNode {
  type: 'text';
  /** Decoded text (raw source for script contents). */
  text: string;
}

type HtmlNode = ElementNode | TextNode;

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const OPEN_TAG_RE =
  /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CLOSE_TAG_RE = /<\/([a-zA-Z][^\s/>]*)\s*>/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Opening one of these closes an open sibling of the same family. */
const IMPLIED_END: Record<string, { closes: string[]; boundary: string[] }> = {
  li: { closes: ['li'], boundary: ['ul', 'ol', 'menu'] },
  dt: { closes: ['dt', 'dd'], boundary: ['dl'] },
  dd: { closes: ['dt', 'dd'], boundary: ['dl'] },
  tr: { closes: ['tr', 'td', 'th'], boundary: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], boundary: ['tr', 'table'] },
  th: { closes: ['td', 'th'], boundary: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], boundary: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], boundary: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], boundary: ['table'] },
  option: { closes: ['option'], boundary: ['select', 'datalist'] },
};

/** Block-level elements: they close an open `<p>` and break prose apart. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br',
]);

/** Inline elements: consecutive runs of them (and text) form one block. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd',
  'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
  'var', 'wbr', 'br', 'img',
]);

/** Never content: skipped when grouping blocks and reading text. */
const NON_CONTENT_TAGS = new Set([
  'head', 'meta', 'link', 'base', 'style', 'title', 'template', 'noscript',
]);

/** Wrappers a lone child can be unwrapped from when finding the top-level blocks. */
const WRAPPER_TAGS = new Set(['html', 'body', 'main', 'article', 'div', 'section', 'form', 'center']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', ndash: '–', mdash: '—', minus: '−', times: '×', euro: '€', pound: '£',
  yen: '¥', cent: '¢', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', deg: '°', plusmn: '±', laquo: '«', raquo: '»', copy: '©',
  reg: '®', trade: '™', frac12: '½', frac14: '¼', frac34: '¾', rarr: '→', larr: '←',
  uarr: '↑', darr: '↓',
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function readAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

function parseHtml(html: string): ElementNode {
  const root: ElementNode = { type: 'element', tag: '#root', attrs: new Map(), children: [], anchor: -1 };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];
  const addText = (raw: string) => {
    if (raw) top().children.push({ type: 'text', text: decodeEntities(raw) });
  };
  const popTo = (index: number) => {
    stack.length = Math.max(1, index);
  };

  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    CLOSE_TAG_RE.lastIndex = lt;
    const close = CLOSE_TAG_RE.exec(html);
    if (close) {
      const tag = close[1].toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag) {
          popTo(s);
          break;
        }
      }
      i = lt + close[0].length;
      continue;
    }

    OPEN_TAG_RE.lastIndex = lt;
    const open = OPEN_TAG_RE.exec(html);
    if (!open) {
      addText('<');
      i = lt + 1;
      continue;
    }

    const tag = open[1].toLowerCase();
    const selfClosing = open[3] === '/';
    const end = lt + open[0].length;
    const anchor = selfClosing ? html.lastIndexOf('/', end - 1) : end - 1;

    // Implied end tags: a new <li> closes the open <li>, a new <td> the open
    // cell, a block the open <p>.
    const implied = IMPLIED_END[tag];
    if (implied) {
      for (let s = stack.length - 1; s >= 1; s--) {
        const t = stack[s].tag;
        if (implied.boundary.includes(t)) break;
        if (implied.closes.includes(t)) {
          popTo(s);
          break;
        }
      }
    }
    if (BLOCK_TAGS.has(tag) && top().tag === 'p') popTo(stack.length - 1);

    const element: ElementNode = {
      type: 'element',
      tag,
      attrs: readAttrs(open[2]),
      children: [],
      anchor,
    };
    top().children.push(element);
    i = end;

    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
      closeRe.lastIndex = end;
      const rawClose = closeRe.exec(html);
      const rawEnd = rawClose ? rawClose.index : len;
      const raw = html.slice(end, rawEnd);
      if (raw) {
        element.children.push({
          type: 'text',
          text: tag === 'script' || tag === 'style' ? raw : decodeEntities(raw),
        });
      }
      i = rawClose ? rawClose.index + rawClose[0].length : len;
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Blocks (sections)
// ---------------------------------------------------------------------------

interface Block {
  key: string | null;
  /** Unique within its document: the key, or `key#2` for a repeated key. */
  matchKey: string | null;
  nodes: HtmlNode[];
  heading: string;
  signature: string;
  /** Anchor for the preview highlight (a single non-script element). */
  anchor?: number;
}

function sectionKeyOf(node: HtmlNode): string | null {
  if (node.type !== 'element') return null;
  const key = node.attrs.get(INSIGHT_SECTION_ATTR);
  return key === undefined ? null : key.trim();
}

function isBlank(node: HtmlNode): boolean {
  return node.type === 'text' && node.text.trim() === '';
}

function isContentNode(node: HtmlNode): boolean {
  if (node.type === 'text') return !isBlank(node);
  return !NON_CONTENT_TAGS.has(node.tag) && node.tag !== 'script';
}

function containsKeyed(node: HtmlNode): boolean {
  if (node.type !== 'element') return false;
  for (const child of node.children) {
    if (sectionKeyOf(child) !== null || containsKeyed(child)) return true;
  }
  return false;
}

function normaliseSpace(text: string): string {
  return text.replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim();
}

/** Visible text of the nodes (skipping nested keyed sections when asked). */
function visibleText(nodes: HtmlNode[], skipKeyed: boolean): string {
  const out: string[] = [];
  const walk = (node: HtmlNode, depth: number) => {
    if (node.type === 'text') {
      out.push(node.text);
      return;
    }
    if (NON_CONTENT_TAGS.has(node.tag) || node.tag === 'script') return;
    if (skipKeyed && depth > 0 && sectionKeyOf(node) !== null) return;
    if (node.attrs.has(SOURCE_REF_ATTR)) return;
    const block = BLOCK_TAGS.has(node.tag);
    if (block) out.push(' ');
    for (const child of node.children) walk(child, depth + 1);
    if (block) out.push(' ');
  };
  for (const node of nodes) walk(node, 0);
  return normaliseSpace(out.join(''));
}

function headingOf(nodes: HtmlNode[], key: string | null): string {
  let heading: string | null = null;
  const find = (node: HtmlNode, depth: number): void => {
    if (heading !== null || node.type !== 'element') return;
    if (depth > 0 && sectionKeyOf(node) !== null) return;
    if (/^h[1-6]$/.test(node.tag) || node.tag === 'caption' || node.tag === 'legend') {
      const text = visibleText([node], true);
      if (text) {
        heading = text;
        return;
      }
    }
    for (const child of node.children) find(child, depth + 1);
  };
  for (const node of nodes) find(node, 0);
  if (heading) return clip(heading, 80);
  const text = visibleText(nodes, true);
  if (text) return clip(text, 60);
  if (key) return key;
  const first = nodes.find((n) => n.type === 'element') as ElementNode | undefined;
  if (first && (first.tag === 'svg' || first.tag === 'canvas')) return 'Chart';
  return first ? `<${first.tag}>` : 'Block';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Attributes that change what a block says (everything else is styling). */
const MEANINGFUL_ATTRS = [
  'href', 'src', 'alt', 'colspan', 'rowspan', 'value', 'datetime', 'title',
  EVIDENCE_ATTR, 'data-reason', 'data-signal-type', 'data-based-on', 'data-limit-id',
  SOURCE_REF_ATTR, 'data-source-id', 'data-source-kind', 'data-retrieved', 'data-feeds',
];

/**
 * A block's content fingerprint: normalised text plus element structure and
 * meaningful attributes, sorted. `class`, `style`, `id`, `<style>` blocks and
 * purely presentational `<span>`/`<font>` wrappers are left out, so a restyle
 * alone reads as unchanged. Script contents are kept (a chart's data lives
 * there), whitespace-collapsed.
 */
function signatureOf(nodes: HtmlNode[]): string {
  const parts: string[] = [];
  // Text runs are joined across presentational wrappers before normalising,
  // so "Revenue <span>$5bn</span>" reads the same as "Revenue $5bn".
  let text = '';
  const push = (token: string) => {
    const t = normaliseSpace(text);
    if (t) parts.push(`"${t}"`);
    text = '';
    parts.push(token);
  };
  const walk = (node: HtmlNode, depth: number) => {
    if (node.type === 'text') {
      text += node.text;
      return;
    }
    if (depth > 0 && sectionKeyOf(node) !== null) {
      push(`[section ${sectionKeyOf(node)}]`);
      return;
    }
    if (NON_CONTENT_TAGS.has(node.tag)) return;
    if (node.tag === 'script') {
      const body = node.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
      push(`<script ${normaliseSpace(body)}>`);
      return;
    }
    const attrs = MEANINGFUL_ATTRS.filter((a) => node.attrs.has(a))
      .sort()
      .map((a) => `${a}=${normaliseSpace(node.attrs.get(a) ?? '')}`);
    const presentational = (node.tag === 'span' || node.tag === 'font') && attrs.length === 0;
    if (!presentational) push(`<${node.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    for (const child of node.children) walk(child, depth + 1);
    if (!presentational && !VOID_TAGS.has(node.tag)) push(`</${node.tag}>`);
  };
  for (const node of nodes) walk(node, 0);
  push('');
  return parts.join('');
}

function makeBlock(nodes: HtmlNode[], key: string | null): Block {
  const single = nodes.length === 1 && nodes[0].type === 'element' ? nodes[0] : null;
  return {
    key,
    matchKey: key,
    nodes,
    heading: headingOf(nodes, key),
    signature: signatureOf(nodes),
    anchor:
      single && single.tag !== 'script' && single.tag !== 'style' && single.anchor >= 0
        ? single.anchor
        : undefined,
  };
}

function contentChildren(el: ElementNode): HtmlNode[] {
  return el.children.filter(isContentNode);
}

/** The element the document's top-level blocks hang off. */
function blockContainer(root: ElementNode): ElementNode {
  let container: ElementNode = root;
  for (let guard = 0; guard < 64; guard++) {
    const kids = contentChildren(container);
    const body = kids.find((k) => k.type === 'element' && (k.tag === 'html' || k.tag === 'body'));
    if (body && body.type === 'element') {
      container = body;
      continue;
    }
    if (
      kids.length === 1 &&
      kids[0].type === 'element' &&
      WRAPPER_TAGS.has(kids[0].tag) &&
      sectionKeyOf(kids[0]) === null
    ) {
      container = kids[0];
      continue;
    }
    break;
  }
  return container;
}

function collectBlocks(container: ElementNode, out: Block[]): void {
  let inlineRun: HtmlNode[] = [];
  const flush = () => {
    if (inlineRun.some((n) => !isBlank(n))) out.push(makeBlock(inlineRun, null));
    inlineRun = [];
  };

  for (const kid of container.children) {
    if (!isContentNode(kid)) {
      if (kid.type === 'text') inlineRun.push(kid);
      continue;
    }
    if (kid.type === 'text') {
      inlineRun.push(kid);
      continue;
    }
    const key = sectionKeyOf(kid);
    if (key !== null) {
      flush();
      pushKeyed(kid, key, out);
      continue;
    }
    if (containsKeyed(kid)) {
      flush();
      collectBlocks(kid, out);
      continue;
    }
    if (INLINE_TAGS.has(kid.tag)) {
      inlineRun.push(kid);
      continue;
    }
    flush();
    out.push(makeBlock([kid], null));
  }
  flush();
}

function pushKeyed(el: ElementNode, key: string, out: Block[]): void {
  out.push(makeBlock([el], key));
  // Keyed sections nested inside it are sections of their own; the parent's
  // fingerprint only notes where they sit.
  const nested = (node: ElementNode) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const childKey = sectionKeyOf(child);
      if (childKey !== null) pushKeyed(child, childKey, out);
      else nested(child);
    }
  };
  nested(el);
}

function blocksOf(html: string): { blocks: Block[]; looseScripts: string } {
  const root = parseHtml(html ?? '');
  const container = blockContainer(root);
  const blocks: Block[] = [];
  collectBlocks(container, blocks);

  const seen = new Map<string, number>();
  for (const block of blocks) {
    if (block.key === null) continue;
    const n = (seen.get(block.key) ?? 0) + 1;
    seen.set(block.key, n);
    block.matchKey = n === 1 ? block.key : `${block.key}#${n}`;
  }

  return { blocks, looseScripts: looseScriptText(root) };
}

/** Every script outside a keyed section, whitespace-collapsed. */
function looseScriptText(root: ElementNode): string {
  const parts: string[] = [];
  const walk = (node: HtmlNode) => {
    if (node.type !== 'element') return;
    if (sectionKeyOf(node) !== null) return;
    if (node.tag === 'script') {
      const src = node.attrs.get('src');
      const body = node.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
      parts.push(`${src ?? ''}|${normaliseSpace(body)}`);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

interface ProseFigure {
  label: string;
  value: string;
}

interface CellFigure {
  key: string;
  label: string;
  value: string;
}

interface BlockFigures {
  prose: ProseFigure[];
  cells: CellFigure[];
}

const CURRENCY =
  'US\\$|S\\$|A\\$|HK\\$|NZ\\$|C\\$|\\$|€|£|¥|₹|Rp\\.?|IDR|USD|EUR|SGD|GBP|JPY|CNY|RMB|AUD|HKD|MYR|RM';
const UNIT =
  '%|pp|bps|bp|x|×|trillion|billion|million|thousand|triliun|miliar|juta|tn|bn|mn|mm|jt|mt|kt|k|m|b|t';
const FIGURE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_$€£¥₹.,])(?:(${CURRENCY})\\s?)?([+\\-−–]?(?:\\d{1,3}(?:[,.]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?))(?:\\s?(${UNIT}))?(?![\\p{L}\\p{N}])`,
  'giu',
);

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mei|agu(?:stus)?|okt(?:ober)?|des(?:ember)?)';
const DATE_RE = new RegExp(
  [
    '\\d{4}-\\d{1,2}-\\d{1,2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2})?)?',
    '\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}',
    `\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?(?:\\s+\\d{2,4})?`,
    `${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`,
    `${MONTH}\\.?\\s+\\d{4}`,
    `${MONTH}\\.?\\s+'\\d{2}`,
    '\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[ap]m)?',
  ]
    .map((p) => `(?<![\\p{L}\\p{N}])(?:${p})(?![\\p{N}])`)
    .join('|'),
  'giu',
);

const SOURCE_REF_TEXT_RE = /\[S\d+\]/g;

function dateRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(DATE_RE)) {
    ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(SOURCE_REF_TEXT_RE)) {
    ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return ranges;
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

interface FigureMatch {
  value: string;
  start: number;
  end: number;
}

/** The figures in a run of text, in order. Years and dates are skipped. */
function figuresIn(text: string): FigureMatch[] {
  const ranges = dateRanges(text);
  const out: FigureMatch[] = [];
  for (const m of text.matchAll(FIGURE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(ranges, start, end)) continue;
    const [, currency, number, unit] = m;
    // A bare four-digit year is a date, not a figure.
    if (!currency && !unit && /^(1[89]|20|21)\d{2}$/.test(number)) continue;
    out.push({ value: normaliseSpace(m[0]), start, end });
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’&/+\-]*/gu;

function lastWords(text: string, count: number): string {
  // Only the current sentence or line: a label never reaches across a full stop.
  const pieces = text.split(/[.;!?](?:\s|$)|\n/);
  for (let p = pieces.length - 1; p >= 0; p--) {
    const words = pieces[p].match(WORD_RE);
    if (words && words.length > 0) return words.slice(-count).join(' ');
    if (p === pieces.length - 1) continue;
    break;
  }
  return '';
}

function firstWords(text: string, count: number): string {
  const piece = text.split(/[.;!?](?:\s|$)|\n/)[0] ?? '';
  const words = piece.match(WORD_RE);
  return words ? words.slice(0, count).join(' ') : '';
}

function proseFigures(text: string): ProseFigure[] {
  const matches = figuresIn(text);
  return matches.map((m, idx) => {
    const from = idx > 0 ? matches[idx - 1].end : 0;
    let label = lastWords(text.slice(from, m.start), 4);
    if (!label) {
      const to = idx + 1 < matches.length ? matches[idx + 1].start : text.length;
      label = firstWords(text.slice(m.end, to), 3);
    }
    return { label: label || `Figure ${idx + 1}`, value: m.value };
  });
}

function isSkippedForFigures(el: ElementNode): boolean {
  return (
    NON_CONTENT_TAGS.has(el.tag) ||
    el.tag === 'script' ||
    el.attrs.has(SOURCE_REF_ATTR) ||
    el.attrs.get(EVIDENCE_ATTR)?.trim() === 'unavailable'
  );
}

/** Text of a node for figure reading: no refs, no unavailable cells, no scripts. */
function figureText(nodes: HtmlNode[]): string {
  const out: string[] = [];
  const walk = (node: HtmlNode) => {
    if (node.type === 'text') {
      out.push(node.text);
      return;
    }
    if (isSkippedForFigures(node)) return;
    const block = BLOCK_TAGS.has(node.tag);
    if (block) out.push('\n');
    for (const child of node.children) walk(child);
    if (block) out.push('\n');
  };
  for (const node of nodes) walk(node);
  return out
    .join('')
    .split('\n')
    .map(normaliseSpace)
    .filter(Boolean)
    .join('\n');
}

function blockFigures(block: Block): BlockFigures {
  const result: BlockFigures = { prose: [], cells: [] };
  // The Sources section is a bibliography: retrieval dates, URLs and queries.
  if (block.key === SOURCES_SECTION_KEY) return result;

  const proseParts: string[] = [];
  let tableIndex = 0;
  const walk = (node: HtmlNode, depth: number) => {
    if (node.type === 'text') {
      proseParts.push(node.text);
      return;
    }
    if (depth > 0 && sectionKeyOf(node) !== null) return;
    if (isSkippedForFigures(node)) return;
    if (node.tag === 'table') {
      proseParts.push('\n');
      tableIndex += 1;
      result.cells.push(...tableFigures(node, tableIndex));
      proseParts.push('\n');
      return;
    }
    const block = BLOCK_TAGS.has(node.tag);
    if (block) proseParts.push('\n');
    for (const child of node.children) walk(child, depth + 1);
    if (block) proseParts.push('\n');
  };
  for (const node of block.nodes) walk(node, 0);

  const prose = proseParts
    .join('')
    .split('\n')
    .map(normaliseSpace)
    .filter(Boolean)
    .join('\n');
  result.prose = proseFigures(prose);
  return result;
}

function childElements(el: ElementNode, tags: string[]): ElementNode[] {
  return el.children.filter(
    (c): c is ElementNode => c.type === 'element' && tags.includes(c.tag),
  );
}

function tableRows(table: ElementNode): { head: ElementNode[]; body: ElementNode[] } {
  const head: ElementNode[] = [];
  const body: ElementNode[] = [];
  for (const child of table.children) {
    if (child.type !== 'element') continue;
    if (child.tag === 'thead') head.push(...childElements(child, ['tr']));
    else if (child.tag === 'tbody' || child.tag === 'tfoot') body.push(...childElements(child, ['tr']));
    else if (child.tag === 'tr') body.push(child);
  }
  if (head.length === 0 && body.length > 0) {
    const cells = childElements(body[0], ['td', 'th']);
    if (cells.length > 0 && cells.every((c) => c.tag === 'th')) head.push(body.shift()!);
  }
  return { head, body };
}

function span(cell: ElementNode): number {
  const n = parseInt(cell.attrs.get('colspan') ?? '1', 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 100) : 1;
}

function tableFigures(table: ElementNode, tableIndex: number): CellFigure[] {
  const caption = childElements(table, ['caption'])[0];
  const tableKey = caption ? visibleText([caption], false) || `table ${tableIndex}` : `table ${tableIndex}`;
  const { head, body } = tableRows(table);

  // Column headers, colspans expanded; several header rows join with " / ".
  const headers: string[] = [];
  for (const row of head) {
    let col = 0;
    for (const cell of childElements(row, ['td', 'th'])) {
      const text = visibleText([cell], false);
      for (let s = 0; s < span(cell); s++) {
        headers[col] = headers[col] && text && headers[col] !== text ? `${headers[col]} / ${text}` : headers[col] || text;
        col += 1;
      }
    }
  }
  const header = (col: number) => headers[col] || `column ${col + 1}`;

  const out: CellFigure[] = [];
  const labelCounts = new Map<string, number>();
  body.forEach((row, rowIndex) => {
    const cells = childElements(row, ['td', 'th']);
    if (cells.length === 0) return;
    const rawLabel = figureText([cells[0]]).replace(/\n/g, ' ') || visibleText([cells[0]], false);
    const baseLabel = rawLabel || `row ${rowIndex + 1}`;
    const n = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, n);
    const rowLabel = n === 1 ? baseLabel : `${baseLabel} (${n})`;

    // A one-cell row: the cell is its own value.
    const valueCells = cells.length === 1 ? [{ cell: cells[0], col: 0 }] : [];
    let col = 0;
    cells.forEach((cell, idx) => {
      if (idx > 0) valueCells.push({ cell, col });
      col += span(cell);
    });

    for (const { cell, col: c } of valueCells) {
      if (cell.attrs.get(EVIDENCE_ATTR)?.trim() === 'unavailable') continue;
      const matches = figuresIn(figureText([cell]).replace(/\n/g, ' '));
      matches.forEach((m, k) => {
        const column = header(c);
        out.push({
          key: `${tableKey}\u0000${rowLabel}\u0000${column}\u0000${k}`,
          label: `${rowLabel} · ${column}${k > 0 ? ` (${k + 1})` : ''}`,
          value: m.value,
        });
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Longest-common-subsequence pairs of equal items, in order. Falls back to no
 * pairs when the table would be too large (the caller then pairs by order).
 */
function lcsPairs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) return [];
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = eq(a[i], b[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

interface Alignment {
  /** before index → after index for every paired item. */
  pairs: Array<{ before: number; after: number; equal: boolean }>;
}

/**
 * Align two sequences: equal items by LCS, then, between two aligned items,
 * the leftovers paired in order (preferring same-label pairs when `label` is
 * given). Unpaired items are added or removed.
 */
function align<T>(
  a: T[],
  b: T[],
  eq: (x: T, y: T) => boolean,
  label?: (x: T) => string,
): Alignment {
  const anchors = lcsPairs(a, b, eq);
  const pairs: Alignment['pairs'] = [];
  let ai = 0;
  let bi = 0;
  const gap = (aEnd: number, bEnd: number) => {
    const restA = range(ai, aEnd);
    const restB = range(bi, bEnd);
    if (label) {
      for (let x = 0; x < restA.length; x++) {
        const y = restB.findIndex((j) => j >= 0 && label(b[j]) === label(a[restA[x]]));
        if (y !== -1) {
          pairs.push({ before: restA[x], after: restB[y], equal: false });
          restA[x] = -1;
          restB[y] = -1;
        }
      }
    }
    const leftA = restA.filter((x) => x >= 0);
    const leftB = restB.filter((y) => y >= 0);
    for (let k = 0; k < Math.min(leftA.length, leftB.length); k++) {
      pairs.push({ before: leftA[k], after: leftB[k], equal: false });
    }
  };
  for (const [x, y] of anchors) {
    gap(x, y);
    pairs.push({ before: x, after: y, equal: true });
    ai = x + 1;
    bi = y + 1;
  }
  gap(a.length, b.length);
  return { pairs };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k < to; k++) out.push(k);
  return out;
}

// ---------------------------------------------------------------------------
// Figure comparison
// ---------------------------------------------------------------------------

function compareFigures(
  before: BlockFigures | null,
  after: BlockFigures | null,
  section: { key: string | null; heading: string },
): FigureChange[] {
  const base = { sectionKey: section.key, sectionHeading: section.heading };
  const out: FigureChange[] = [];

  // Table cells, keyed by (table, row label, column header).
  const beforeCells = new Map((before?.cells ?? []).map((c) => [c.key, c]));
  const afterKeys = new Set<string>();
  for (const cell of after?.cells ?? []) {
    afterKeys.add(cell.key);
    const prior = beforeCells.get(cell.key);
    if (!prior) out.push({ ...base, label: cell.label, before: null, after: cell.value, kind: 'added' });
    else if (prior.value !== cell.value)
      out.push({ ...base, label: cell.label, before: prior.value, after: cell.value, kind: 'changed' });
  }
  for (const cell of before?.cells ?? []) {
    if (!afterKeys.has(cell.key))
      out.push({ ...base, label: cell.label, before: cell.value, after: null, kind: 'removed' });
  }

  // Prose, aligned within the section.
  const a = before?.prose ?? [];
  const b = after?.prose ?? [];
  const { pairs } = align(
    a,
    b,
    (x, y) => x.label === y.label && x.value === y.value,
    (x) => x.label,
  );
  const pairedA = new Set(pairs.map((p) => p.before));
  const pairedB = new Map(pairs.map((p) => [p.after, p.before]));
  b.forEach((fig, j) => {
    const i = pairedB.get(j);
    if (i === undefined) {
      out.push({ ...base, label: fig.label, before: null, after: fig.value, kind: 'added' });
    } else if (a[i].value !== fig.value) {
      out.push({ ...base, label: fig.label, before: a[i].value, after: fig.value, kind: 'changed' });
    }
  });
  a.forEach((fig, i) => {
    if (!pairedA.has(i))
      out.push({ ...base, label: fig.label, before: fig.value, after: null, kind: 'removed' });
  });

  return out;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * Diff the current version's HTML (`beforeHtml`) against a candidate's
 * (`afterHtml`). Sections come back in the candidate's order, with removed
 * sections placed where they sat in the current version.
 */
export function diffInsightVersions(beforeHtml: string, afterHtml: string): InsightVersionDiff {
  const before = blocksOf(beforeHtml ?? '');
  const after = blocksOf(afterHtml ?? '');
  const bBlocks = before.blocks;
  const aBlocks = after.blocks;

  // before index → after index
  const matchOf = new Map<number, number>();

  // Keyed blocks: by key.
  const afterByKey = new Map<string, number>();
  aBlocks.forEach((blk, j) => {
    if (blk.matchKey !== null) afterByKey.set(blk.matchKey, j);
  });
  bBlocks.forEach((blk, i) => {
    if (blk.matchKey === null) return;
    const j = afterByKey.get(blk.matchKey);
    if (j !== undefined) matchOf.set(i, j);
  });

  // Unkeyed blocks: by order, equal content first.
  const bUnkeyed = range(0, bBlocks.length).filter((i) => bBlocks[i].key === null);
  const aUnkeyed = range(0, aBlocks.length).filter((j) => aBlocks[j].key === null);
  const { pairs } = align(
    bUnkeyed,
    aUnkeyed,
    (i, j) => bBlocks[i].signature === aBlocks[j].signature,
  );
  for (const p of pairs) matchOf.set(bUnkeyed[p.before], aUnkeyed[p.after]);

  const afterMatched = new Map<number, number>();
  for (const [i, j] of matchOf) afterMatched.set(j, i);

  const sections: SectionDiff[] = [];
  const figures: FigureChange[] = [];
  const figureCache = new Map<Block, BlockFigures>();
  const figuresOf = (blk: Block) => {
    let cached = figureCache.get(blk);
    if (!cached) {
      cached = blockFigures(blk);
      figureCache.set(blk, cached);
    }
    return cached;
  };

  // Removed blocks sit after the nearest preceding matched before-block.
  const removedAt = new Map<number, number[]>();
  let anchorAfter = -1;
  bBlocks.forEach((_, i) => {
    const j = matchOf.get(i);
    if (j !== undefined) {
      anchorAfter = j;
      return;
    }
    const list = removedAt.get(anchorAfter) ?? [];
    list.push(i);
    removedAt.set(anchorAfter, list);
  });

  const emitRemoved = (at: number) => {
    for (const i of removedAt.get(at) ?? []) {
      const blk = bBlocks[i];
      sections.push({ key: blk.key, heading: blk.heading, status: 'removed' });
      figures.push(...compareFigures(figuresOf(blk), null, blk));
    }
  };

  emitRemoved(-1);
  aBlocks.forEach((blk, j) => {
    const i = afterMatched.get(j);
    if (i === undefined) {
      sections.push({ key: blk.key, heading: blk.heading, status: 'added', ...anchorOf(blk) });
      figures.push(...compareFigures(null, figuresOf(blk), blk));
    } else if (bBlocks[i].signature === blk.signature) {
      sections.push({ key: blk.key, heading: blk.heading, status: 'unchanged' });
    } else {
      sections.push({ key: blk.key, heading: blk.heading, status: 'changed', ...anchorOf(blk) });
      figures.push(...compareFigures(figuresOf(bBlocks[i]), figuresOf(blk), blk));
    }
    emitRemoved(j);
  });

  const count = (s: SectionStatus) => sections.filter((x) => x.status === s).length;
  const countFig = (k: FigureChangeKind) => figures.filter((f) => f.kind === k).length;
  const scriptsChanged = before.looseScripts !== after.looseScripts;

  const summary: InsightDiffSummary = {
    sectionsChanged: count('changed'),
    sectionsAdded: count('added'),
    sectionsRemoved: count('removed'),
    sectionsUnchanged: count('unchanged'),
    figuresChanged: countFig('changed'),
    figuresAdded: countFig('added'),
    figuresRemoved: countFig('removed'),
    figuresOmitted: Math.max(0, figures.length - MAX_FIGURE_CHANGES),
    scriptsChanged,
    hasChanges: false,
  };
  summary.hasChanges =
    scriptsChanged ||
    summary.sectionsChanged + summary.sectionsAdded + summary.sectionsRemoved > 0 ||
    figures.length > 0;

  return { sections, figures: figures.slice(0, MAX_FIGURE_CHANGES), summary };
}

function anchorOf(blk: Block): { anchor?: number } {
  return blk.anchor === undefined ? {} : { anchor: blk.anchor };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function countPhrase(noun: string, items: Array<[number, string]>): string | null {
  const present = items.filter(([n]) => n > 0);
  if (present.length === 0) return null;
  return present
    .map(([n, word], idx) => (idx === 0 ? `${n} ${noun}${n === 1 ? '' : 's'} ${word}` : `${n} ${word}`))
    .join(', ');
}

/** "3 sections changed, 1 added · 7 figures changed" */
export function formatDiffSummary(summary: InsightDiffSummary): string {
  const parts = [
    countPhrase('section', [
      [summary.sectionsChanged, 'changed'],
      [summary.sectionsAdded, 'added'],
      [summary.sectionsRemoved, 'removed'],
    ]),
    countPhrase('figure', [
      [summary.figuresChanged, 'changed'],
      [summary.figuresAdded, 'added'],
      [summary.figuresRemoved, 'removed'],
    ]),
    summary.scriptsChanged ? 'chart or page scripts changed' : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return 'No content changes — only styling or markup differs';
  return parts.join(' · ');
}

/** The attribute the preview highlight marks a section with. */
export const DIFF_HIGHLIGHT_ATTR = 'data-insight-diff';

const HIGHLIGHT_STYLE =
  `<style data-insight-diff-style>` +
  `[${DIFF_HIGHLIGHT_ATTR}]{outline:2px solid #d97706 !important;outline-offset:3px;border-radius:2px;scroll-margin:24px}` +
  `[${DIFF_HIGHLIGHT_ATTR}="added"]{outline-color:#16a34a !important}` +
  `</style>`;

/**
 * The candidate HTML with its changed and added sections outlined, for the
 * After preview ONLY — the published document is the untouched candidate.
 * `diff` must have been computed from this same `afterHtml` (the anchors are
 * offsets into it).
 */
export function highlightPreviewHtml(afterHtml: string, diff: InsightVersionDiff): string {
  const marks = diff.sections
    .filter(
      (s): s is SectionDiff & { anchor: number } =>
        (s.status === 'changed' || s.status === 'added') &&
        typeof s.anchor === 'number' &&
        s.anchor >= 0 &&
        s.anchor <= afterHtml.length,
    )
    .sort((x, y) => y.anchor - x.anchor);
  if (marks.length === 0) return afterHtml;

  let html = afterHtml;
  for (const mark of marks) {
    html = `${html.slice(0, mark.anchor)} ${DIFF_HIGHLIGHT_ATTR}="${mark.status}"${html.slice(mark.anchor)}`;
  }
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  return bodyClose === -1
    ? html + HIGHLIGHT_STYLE
    : html.slice(0, bodyClose) + HIGHLIGHT_STYLE + html.slice(bodyClose);
}
