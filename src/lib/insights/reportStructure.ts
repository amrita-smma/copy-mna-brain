/**
 * Structural validator for report insights (MB-565).
 *
 * A report is a self-contained HTML document that must obey a fixed structural
 * contract: three ordered sections (summary, details, appendix), word count
 * bounds on the summary, a counter-case element in details, adjacent
 * interpretation text for all non-decorative visualisations, and a visualisation
 * ratio cap in details.
 *
 * This is deliberately NOT part of insightService or DB persistence: insights
 * stored before this rule exists must stay publishable and rollback-able. It is
 * enforced on the model-facing tool path only.
 */

import { VOID_TAGS } from '@/lib/insights/htmlTags';
import { INSIGHT_SECTION_ATTR } from '@/lib/insights/srcdoc';

const DATA_SECTION_RE = new RegExp(
  `(?:^|\\s)${INSIGHT_SECTION_ATTR}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
  'i',
);

const TAG_RE =
  /<(\/)?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9_:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/)?>/g;

const ATTR_RE =
  /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const SECTION_TAG_RE = /<(\/)?section\b([^>]*)>/gi;

interface ExtractedSection {
  key: string;
  content: string;
}

interface SectionScanResult {
  sections: ExtractedSection[];
  hasUnclosedSections: boolean;
}

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
  parent: HtmlNode | null;
}

interface Block {
  type: 'viz' | 'text' | 'heading';
  tag: string;
  wordCount: number;
}

function extractTextContent(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;|&#160;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;|&apos;/gi, "'");
  return text.replace(/\s+/g, ' ').trim();
}

function countWords(str: string): number {
  const clean = extractTextContent(str);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

function isSectionEmpty(content: string): boolean {
  return content.replace(/<!--[\s\S]*?-->/g, '').trim().length === 0;
}

function extractSections(cleanHtml: string): SectionScanResult {
  const stack: { key: string; openTagEnd: number }[] = [];
  const sections: ExtractedSection[] = [];
  let hasUnclosedSections = false;

  SECTION_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SECTION_TAG_RE.exec(cleanHtml)) !== null) {
    const isClose = !!match[1];
    const attrsStr = match[2] ?? '';
    const tagEnd = match.index + match[0].length;

    if (!isClose) {
      const dataSectionMatch = attrsStr.match(DATA_SECTION_RE);
      const key = (
        dataSectionMatch?.[1] ??
        dataSectionMatch?.[2] ??
        dataSectionMatch?.[3] ??
        ''
      ).toLowerCase();
      stack.push({ key, openTagEnd: tagEnd });
    } else {
      if (stack.length === 0) {
        hasUnclosedSections = true;
      } else {
        const top = stack.pop()!;
        if (stack.length === 0) {
          const content = cleanHtml.slice(top.openTagEnd, match.index);
          sections.push({ key: top.key, content });
        }
      }
    }
  }

  if (stack.length > 0) {
    hasUnclosedSections = true;
  }

  return { sections, hasUnclosedSections };
}

function parseHtmlTree(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [], parent: null };
  let current: HtmlNode = root;
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(clean)) !== null) {
    if (match.index > lastIndex) {
      const text = clean.slice(lastIndex, match.index);
      if (text.trim().length > 0) {
        current.children.push(text);
      }
    }
    lastIndex = match.index + match[0].length;

    const isClose = !!match[1];
    const tagName = match[2].toLowerCase();
    const attrsRaw = match[3] ?? '';
    const isSelfClosing = match[4] === '/' || VOID_TAGS.has(tagName);

    if (isClose) {
      let node: HtmlNode | null = current;
      while (node && node.tag !== tagName && node !== root) {
        node = node.parent;
      }
      if (node && node !== root && node.parent) {
        current = node.parent;
      }
    } else {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = ATTR_RE.exec(attrsRaw)) !== null) {
        attrs[attrMatch[1].toLowerCase()] =
          attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      }

      const child: HtmlNode = {
        tag: tagName,
        attrs,
        children: [],
        parent: current,
      };
      current.children.push(child);

      if (!isSelfClosing) {
        current = child;
      }
    }
  }

  if (lastIndex < clean.length) {
    const text = clean.slice(lastIndex);
    if (text.trim().length > 0) {
      current.children.push(text);
    }
  }

  return root;
}

function getText(node: HtmlNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(getText).join(' ');
}

function hasAncestor(
  node: HtmlNode,
  predicate: (n: HtmlNode) => boolean,
): boolean {
  let curr = node.parent;
  while (curr !== null) {
    if (predicate(curr)) return true;
    curr = curr.parent;
  }
  return false;
}

function isDecorativeSvg(node: HtmlNode): boolean {
  if (node.tag !== 'svg') return false;
  if ('data-decorative' in node.attrs) return true;
  return hasAncestor(
    node,
    (p) =>
      /^h[1-6]$/.test(p.tag) ||
      p.tag === 'button' ||
      p.tag === 'a' ||
      p.tag === 'figure' ||
      p.tag === 'table',
  );
}

function findCounterCaseElements(
  node: HtmlNode,
  found: HtmlNode[] = [],
): HtmlNode[] {
  if ('data-counter-case' in node.attrs) {
    found.push(node);
  }
  for (const child of node.children) {
    if (typeof child !== 'string') {
      findCounterCaseElements(child, found);
    }
  }
  return found;
}

function collectBlocks(node: HtmlNode, blocks: Block[] = []): Block[] {
  if (node.tag === 'table' || node.tag === 'canvas' || node.tag === 'figure') {
    blocks.push({ type: 'viz', tag: node.tag, wordCount: 0 });
    return blocks;
  }
  if (node.tag === 'svg') {
    if (!isDecorativeSvg(node)) {
      blocks.push({ type: 'viz', tag: 'svg', wordCount: 0 });
    }
    return blocks;
  }
  if (node.tag === 'p' || node.tag === 'ul' || node.tag === 'ol') {
    const words = countWords(getText(node));
    blocks.push({ type: 'text', tag: node.tag, wordCount: words });
    return blocks;
  }
  if (/^h[1-6]$/.test(node.tag)) {
    const words = countWords(getText(node));
    blocks.push({
      type: 'heading',
      tag: node.tag,
      wordCount: words,
    });
    return blocks;
  }

  for (const child of node.children) {
    if (typeof child !== 'string') {
      collectBlocks(child, blocks);
    }
  }
  return blocks;
}

function validateAdjacentInterpretation(
  blocks: Block[],
  sectionName: string,
): string | null {
  const isInterp = (b: Block | undefined) =>
    !!b &&
    b.type === 'text' &&
    (b.tag === 'p' || b.tag === 'ul' || b.tag === 'ol') &&
    b.wordCount >= 15;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'viz') {
      if (!isInterp(blocks[i - 1]) && !isInterp(blocks[i + 1])) {
        return `visualisation block <${block.tag}> in the ${sectionName} section must have an interpreting text block (<p>, <ul>, <ol>) with at least 15 words immediately before or after it.`;
      }
    }
  }
  return null;
}

/** A human-readable problem for the model to act on, or null when valid. */
export function validateReportStructure(html: string): string | null {
  if (typeof html !== 'string') {
    return 'the document must be a valid HTML string.';
  }

  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');

  // ─── Rule 1: Three sections ────────────────────────────────────────────────
  const { sections, hasUnclosedSections } = extractSections(cleanHtml);

  if (hasUnclosedSections) {
    return 'sections are unclosed; summary, details, and appendix must be separate top-level sections.';
  }

  const REQUIRED = ['summary', 'details', 'appendix'] as const;
  const counts = new Map<string, number>();
  for (const s of sections) {
    counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  }

  for (const key of REQUIRED) {
    if (!counts.get(key)) {
      return `the document is missing a <section data-section="${key}"> section.`;
    }
  }

  for (const key of REQUIRED) {
    if ((counts.get(key) ?? 0) > 1) {
      return `the document contains multiple <section data-section="${key}"> sections; exactly one is required.`;
    }
  }

  const order = sections
    .filter((s) => (REQUIRED as readonly string[]).includes(s.key))
    .map((s) => s.key)
    .join(',');
  if (order !== REQUIRED.join(',')) {
    return 'sections are out of order; expected summary, details, and appendix in document order.';
  }

  // A report is built one section per turn and each write is validated, so a
  // section is checked once it is filled. Empty sections skip their content rules.

  // ─── Rule 2: Summary length ────────────────────────────────────────────────
  const summarySection = sections.find((s) => s.key === 'summary')!;
  if (!isSectionEmpty(summarySection.content)) {
    const summaryWords = countWords(summarySection.content);
    if (summaryWords < 150 || summaryWords > 250) {
      return `the Summary section is ${summaryWords} words; it must be between 150 and 250.`;
    }
  }

  // ─── Rule 3: Counter-case ──────────────────────────────────────────────────
  const detailsSection = sections.find((s) => s.key === 'details')!;
  const detailsEmpty = isSectionEmpty(detailsSection.content);
  let detailsTree: HtmlNode | null = null;

  if (!detailsEmpty) {
    detailsTree = parseHtmlTree(detailsSection.content);
    const counterCaseElements = findCounterCaseElements(detailsTree);

    if (counterCaseElements.length === 0) {
      return 'the details section must contain an element carrying a data-counter-case attribute.';
    }

    let maxCounterWords = 0;
    for (const el of counterCaseElements) {
      const words = countWords(getText(el));
      if (words > maxCounterWords) {
        maxCounterWords = words;
      }
    }

    if (maxCounterWords < 40) {
      return `the counter-case element is ${maxCounterWords} words; it must be at least 40 words.`;
    }
  }

  // ─── Rule 4: Adjacent interpretation ───────────────────────────────────────
  let detailsBlocks: Block[] = [];
  for (const key of ['details', 'appendix'] as const) {
    const section = sections.find((s) => s.key === key)!;
    if (isSectionEmpty(section.content)) {
      continue;
    }
    const tree =
      key === 'details' && detailsTree
        ? detailsTree
        : parseHtmlTree(section.content);
    const blocks = collectBlocks(tree);
    if (key === 'details') detailsBlocks = blocks;
    const problem = validateAdjacentInterpretation(blocks, key);
    if (problem) return problem;
  }

  // ─── Rule 5: Visualisation ratio ───────────────────────────────────────────
  if (!detailsEmpty) {
    const vizCount = detailsBlocks.filter((b) => b.type === 'viz').length;
    const textCount = detailsBlocks.filter(
      (b) =>
        b.type === 'text' ||
        (b.type === 'heading' && (b.tag === 'h2' || b.tag === 'h3')),
    ).length;

    const total = vizCount + textCount;
    if (total > 0) {
      const ratio = vizCount / total;
      if (ratio > 0.4) {
        const pct = Math.round(ratio * 1000) / 10;
        const pctStr = `${pct}%`;
        return `the details section visualisation ratio is ${pctStr}; it must not exceed 40%.`;
      }
    }
  }

  return null;
}
