import { INSIGHT_SECTION_ATTR } from '@/lib/insights/srcdoc';

/**
 * Result of attempting to replace a section in an HTML document.
 */
export type SectionEditResult =
  | { success: true; html: string; error?: undefined }
  | { success: false; error: string; html?: undefined };

import { VOID_TAGS } from '@/lib/insights/htmlTags';

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

interface SectionSpan {
  key: string;
  start: number;
  end: number;
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
  if (typeof html !== 'string' || html.length === 0) {
    return { success: false, error: 'HTML document is empty or invalid.' };
  }
  const targetKey = sectionKey?.trim();
  if (!targetKey) {
    return { success: false, error: 'Section key is required.' };
  }

  const stack: StackEntry[] = [];
  const foundSections: SectionSpan[] = [];
  let unclosedTargetCount = 0;

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(html)) !== null) {
    const raw = match[0];

    // Check if script or style element carried the section attribute on its open tag
    if (/^<script\b/i.test(raw) || /^<style\b/i.test(raw)) {
      const openTagMatch = raw.match(/^<(?:script|style)\b([^>]*)>/i);
      if (openTagMatch) {
        const attrs = openTagMatch[1] ?? '';
        const attrMatch = attrs.match(DATA_SECTION_RE);
        const key = attrMatch ? (attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? '') : undefined;
        if (key !== undefined) {
          foundSections.push({
            key,
            start: match.index,
            end: match.index + raw.length,
          });
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
      const attrMatch = attrsStr.match(DATA_SECTION_RE);
      const key = attrMatch ? (attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? '') : undefined;

      if (isSelfClosing) {
        if (key !== undefined) {
          foundSections.push({
            key,
            start: match.index,
            end: match.index + raw.length,
          });
        }
      } else {
        stack.push({
          tag: tagName.toLowerCase(),
          key,
          start: match.index,
        });
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
          if (orphaned.key === targetKey) {
            unclosedTargetCount++;
          }
        }
        const entry = stack[targetIdx];
        if (entry.key !== undefined) {
          foundSections.push({
            key: entry.key,
            start: entry.start,
            end: match.index + raw.length,
          });
        }
        stack.length = targetIdx;
      }
    }
  }

  for (const entry of stack) {
    if (entry.key === targetKey) {
      unclosedTargetCount++;
    }
  }

  const matchingSpans = foundSections.filter((s) => s.key === targetKey);
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

  const span = matchingSpans[0];
  const spliced = html.slice(0, span.start) + replacement + html.slice(span.end);
  return { success: true, html: spliced };
}
