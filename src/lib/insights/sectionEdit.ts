import { INSIGHT_SECTION_ATTR } from '@/lib/insights/srcdoc';
import { VOID_TAGS } from '@/lib/insights/htmlTags';

/**
 * Result of attempting to replace a section in an HTML document.
 */
export type SectionEditResult =
  | { success: true; html: string; error?: undefined }
  | { success: false; error: string; html?: undefined };

/**
 * Tokenizer matching HTML comments, script tags, style tags, CDATA, DOCTYPE,
 * or general HTML tags while preserving character offsets in the original document.
 */
const TOKEN_RE =
  /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE\b[^>]*>|<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^"'>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?|\s+[^"'>/]+)*)\s*(\/)?>/gi;

/**
 * Matches the section attribute on tag attributes.
 * Handles quoting variants: double quotes, single quotes, unquoted, and whitespace around =.
 * Preserves key case (no lowercase transform).
 */
const DATA_SECTION_RE = new RegExp(
  `(?:^|\\s)${INSIGHT_SECTION_ATTR}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
  'i',
);

interface StackEntry {
  tag: string;
  key?: string;
  start: number;
}

/** One keyed block: its key and the byte span of its outer HTML. */
export interface InsightSectionSpan {
  key: string;
  start: number;
  end: number;
}

interface SectionScan {
  /** Every closed keyed block, in the order its close tag was met. */
  spans: InsightSectionSpan[];
  /** Keys of keyed blocks the document never closes. */
  unclosedKeys: string[];
}

function sectionKeyOf(attrs: string): string | undefined {
  const attrMatch = attrs.match(DATA_SECTION_RE);
  return attrMatch ? (attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? '') : undefined;
}

/**
 * Walks the document once and records every `data-section` block's byte
 * span. Pure string work on the raw source — no parser — so a found span can
 * be cut out or spliced over with every other byte left identical.
 */
function scanInsightSections(html: string): SectionScan {
  const stack: StackEntry[] = [];
  const spans: InsightSectionSpan[] = [];
  const unclosedKeys: string[] = [];

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(html)) !== null) {
    const raw = match[0];

    // Check if script or style element carried the section attribute on its open tag
    if (/^<script\b/i.test(raw) || /^<style\b/i.test(raw)) {
      const openTagMatch = raw.match(/^<(?:script|style)\b([^>]*)>/i);
      if (openTagMatch) {
        const key = sectionKeyOf(openTagMatch[1] ?? '');
        if (key !== undefined) {
          spans.push({ key, start: match.index, end: match.index + raw.length });
        }
      }
      continue;
    }

    // Skip non-tag tokens (comments, CDATA, DOCTYPE)
    if (!match[2]) {
      continue;
    }

    const isClose = Boolean(match[1]);
    const tagName = match[2];
    const attrsStr = match[3] ?? '';
    const isSelfClosing = Boolean(match[4]) || VOID_TAGS.has(tagName.toLowerCase());

    if (!isClose) {
      const key = sectionKeyOf(attrsStr);

      if (isSelfClosing) {
        if (key !== undefined) {
          spans.push({ key, start: match.index, end: match.index + raw.length });
        }
      } else {
        stack.push({ tag: tagName.toLowerCase(), key, start: match.index });
      }
    } else {
      const lowerTag = tagName.toLowerCase();
      let targetIdx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === lowerTag) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx !== -1) {
        for (let j = targetIdx + 1; j < stack.length; j++) {
          const orphaned = stack[j];
          if (orphaned.key !== undefined) {
            unclosedKeys.push(orphaned.key);
          }
        }
        const entry = stack[targetIdx];
        if (entry.key !== undefined) {
          spans.push({ key: entry.key, start: entry.start, end: match.index + raw.length });
        }
        stack.length = targetIdx;
      }
    }
  }

  for (const entry of stack) {
    if (entry.key !== undefined) {
      unclosedKeys.push(entry.key);
    }
  }

  return { spans, unclosedKeys };
}

export type SectionFindResult =
  | { success: true; span: InsightSectionSpan; error?: undefined }
  | { success: false; error: string; span?: undefined };

/**
 * Locates the one element carrying `data-section="<key>"`: its byte span in
 * the document. Fails when the key is absent, duplicated, or on an element the
 * document never closes — each with a reason written to the model.
 */
export function findInsightSection(html: string, sectionKey: string): SectionFindResult {
  if (typeof html !== 'string' || html.length === 0) {
    return { success: false, error: 'HTML document is empty or invalid.' };
  }
  const targetKey = sectionKey?.trim();
  if (!targetKey) {
    return { success: false, error: 'Section key is required.' };
  }

  const { spans, unclosedKeys } = scanInsightSections(html);
  const matchingSpans = spans.filter((s) => s.key === targetKey);
  const unclosedTargetCount = unclosedKeys.filter((k) => k === targetKey).length;
  const totalFound = matchingSpans.length + unclosedTargetCount;

  if (totalFound === 0) {
    return { success: false, error: `Section "${targetKey}" not found in document.` };
  }

  if (totalFound > 1) {
    return {
      success: false,
      error: `Duplicate section key "${targetKey}" found (${totalFound} occurrences). Section keys must be unique.`,
    };
  }

  if (unclosedTargetCount > 0) {
    return { success: false, error: `Unclosed element for section "${targetKey}".` };
  }

  return { success: true, span: matchingSpans[0] };
}

/**
 * Every `data-section` key in the document, in document order of each
 * block's start, duplicates included. What a reader is told when the key it
 * asked for is not there.
 */
export function listInsightSectionKeys(html: string): string[] {
  if (typeof html !== 'string' || html.length === 0) return [];
  const { spans, unclosedKeys } = scanInsightSections(html);
  const ordered = [...spans].sort((a, b) => a.start - b.start).map((s) => s.key);
  return [...ordered, ...unclosedKeys];
}

/**
 * Cuts the element carrying `data-section="<key>"` out of the document: its
 * outer HTML, byte-for-byte. The chat read of one section, so an edit of that
 * section carries only its bytes in and out of the model.
 */
export function extractInsightSection(html: string, sectionKey: string): SectionEditResult {
  const found = findInsightSection(html, sectionKey);
  if (!found.success) return { success: false, error: found.error };
  return { success: true, html: html.slice(found.span.start, found.span.end) };
}

/**
 * Replaces the element carrying `data-section="<key>"` in an HTML document with
 * a replacement fragment, leaving every other byte identical.
 *
 * @param html The original full HTML document string.
 * @param sectionKey The exact key of the target section (case-sensitive).
 * @param replacement The replacement HTML string for the section element.
 * @returns A SectionEditResult indicating success with updated HTML, or failure with a reason.
 */
export function replaceInsightSection(
  html: string,
  sectionKey: string,
  replacement: string,
): SectionEditResult {
  const found = findInsightSection(html, sectionKey);
  if (!found.success) return { success: false, error: found.error };
  const { span } = found;
  const spliced = html.slice(0, span.start) + replacement + html.slice(span.end);
  return { success: true, html: spliced };
}
