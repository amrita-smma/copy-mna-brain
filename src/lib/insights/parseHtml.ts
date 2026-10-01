/**
 * The only way insight and template HTML is parsed. Pure and client-safe.
 *
 * node-html-parser's default parse repairs unclosed tags by moving each
 * unclosed element's children up one level at a time, which is superlinear:
 * `'<div>'.repeat(n)` took 19 s at 32 KB, and 50 unclosed elements holding
 * 2,000 children each took 64 s. A stored document like that hung every
 * chat turn that outlined it. With these options the parse stays linear
 * (about 1 s for a hostile 4 MB document). Unclosed tags stay open, as in a
 * browser, and a closing tag closes the elements still open inside it.
 *
 * A linear parse can still build a tree too deep to walk: the recursive walks
 * (`.text`, `querySelector`, the outline) overflow the stack. Writes refuse a
 * document nested past MAX_INSIGHT_NESTING_DEPTH, and readers check
 * `isTooDeeplyNested` before they walk an older one.
 */
import { parse, NodeType, type HTMLElement, type Options } from 'node-html-parser';

/** Deepest element nesting an insight or template may have. Real documents stay under ~50. */
export const MAX_INSIGHT_NESTING_DEPTH = 512;

export const TOO_DEEPLY_NESTED_MESSAGE = `The HTML is nested more than ${MAX_INSIGHT_NESTING_DEPTH} elements deep, usually from tags that are opened and never closed. Close them and try again.`;

export function parseInsightHtml(html: string, options: Partial<Options> = {}): HTMLElement {
  return parse(html ?? '', {
    ...options,
    parseNoneClosedTags: true,
    closeAllByClosing: true,
  });
}

/** True when `root` nests deeper than `limit`. Iterative, so it never overflows. */
export function isTooDeeplyNested(
  root: HTMLElement,
  limit: number = MAX_INSIGHT_NESTING_DEPTH,
): boolean {
  const stack: { node: HTMLElement; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > limit) return true;
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.ELEMENT_NODE) {
        stack.push({ node: child as HTMLElement, depth: depth + 1 });
      }
    }
  }
  return false;
}

/** The refusal for `html` nested too deeply to be safe to store, or null. */
export function rejectTooDeeplyNested(html: string): string | null {
  return isTooDeeplyNested(parseInsightHtml(html)) ? TOO_DEEPLY_NESTED_MESSAGE : null;
}
