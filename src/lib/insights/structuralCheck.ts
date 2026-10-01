/**
 * Structural check for insight HTML documents.
 * Truncation is detected by counting tags in the raw source because
 * node-html-parser auto-closes tags, so the parsed tree cannot show truncation.
 */

import { NodeType } from 'node-html-parser';
import {
  TOO_DEEPLY_NESTED_MESSAGE,
  isTooDeeplyNested,
  parseInsightHtml,
} from '@/lib/insights/parseHtml';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import type { InsightKind } from '@/lib/insights/types';

const COMPLETE_COMMENTS_RE = /<!--[\s\S]*?-->/g;
const COMPLETE_SCRIPT_RE = /<script\b[\s\S]*?<\/script\s*>/gi;
const COMPLETE_STYLE_RE = /<style\b[\s\S]*?<\/style\s*>/gi;

/**
 * The render check alone: an empty document or body, and the marks of a
 * truncated document (an unterminated comment, an unclosed `<script>`,
 * `<style>`, `<html>` or `<body>`). Returns the reason, or null when it
 * passes. {@link checkInsightStructure} adds the document guard on top.
 */
export function checkInsightTruncation(html: string): string | null {
  // 1. Empty or whitespace-only document
  if (!html || html.trim().length === 0) {
    return 'HTML document is empty.';
  }

  // 2. Unterminated comment (truncated HTML)
  const withoutCompleteComments = html.replace(COMPLETE_COMMENTS_RE, '');
  if (withoutCompleteComments.includes('<!--')) {
    return 'Document contains an unterminated comment (truncated HTML).';
  }

  // 3. Count <script> and <style> opens vs closes with complete comments removed
  const scriptOpens = (withoutCompleteComments.match(/<script\b/gi) ?? []).length;
  const scriptCloses = (withoutCompleteComments.match(/<\/script\s*>/gi) ?? []).length;
  if (scriptOpens > scriptCloses) {
    return 'Document contains an unclosed <script> tag (truncated HTML).';
  }

  const styleOpens = (withoutCompleteComments.match(/<style\b/gi) ?? []).length;
  const styleCloses = (withoutCompleteComments.match(/<\/style\s*>/gi) ?? []).length;
  if (styleOpens > styleCloses) {
    return 'Document contains an unclosed <style> tag (truncated HTML).';
  }

  // 4. Check unclosed <html> and <body> with comments and complete script/style blocks removed.
  //    A fragment with no <html>/<body> at all is legal and passes.
  const stripped = withoutCompleteComments
    .replace(COMPLETE_SCRIPT_RE, '')
    .replace(COMPLETE_STYLE_RE, '');

  const hasHtmlOpen = /<html\b/i.test(stripped);
  const hasHtmlClose = /<\/html\s*>/i.test(stripped);
  if (hasHtmlOpen && !hasHtmlClose) {
    return 'Document contains an unclosed <html> tag (truncated HTML).';
  }

  const hasBodyOpen = /<body\b/i.test(stripped);
  const hasBodyClose = /<\/body\s*>/i.test(stripped);
  if (hasBodyOpen && !hasBodyClose) {
    return 'Document contains an unclosed <body> tag (truncated HTML).';
  }

  // 5. Parse with node-html-parser: verify body or root is not empty.
  const root = parseInsightHtml(html);
  if (isTooDeeplyNested(root)) return TOO_DEEPLY_NESTED_MESSAGE;
  const target = root.querySelector('body') ?? root;
  const hasElementChildren = target.childNodes.some(
    (node) => node.nodeType === NodeType.ELEMENT_NODE,
  );
  const hasNonWhitespaceText = target.text.trim().length > 0;
  if (!hasElementChildren && !hasNonWhitespaceText) {
    return 'Document body is empty.';
  }

  return null;
}

/**
 * Validates the structural integrity of an insight HTML document.
 * Returns a model/user-readable failure reason, or null if the document passes
 * the structural check.
 */
export function checkInsightStructure(
  html: string,
  kind?: InsightKind,
): string | null {
  // Render check first, then documentGuard for placeholder and kind-specific
  // contract validation.
  return checkInsightTruncation(html) ?? rejectInvalidInsightDocument(html, kind);
}

// ---------------------------------------------------------------------------
// The candidate render check (MB-555)
// ---------------------------------------------------------------------------

/**
 * Who a refused candidate goes back to, which decides what the refusal tells
 * the agent to do next:
 *   - `edit-proposal` / `create-proposal`: the chat `propose_insight_*` tools —
 *     no card is offered, and the agent reports the failure to the user;
 *   - `workforce-document` / `workforce-create` / `workforce-section`: the
 *     workforce write tools — nothing is written, and the agent reports the
 *     failure in its run output.
 */
export type CandidateAudience =
  | 'edit-proposal'
  | 'create-proposal'
  | 'workforce-document'
  | 'workforce-create'
  | 'workforce-section';

/** Opens every MB-555 refusal, so a test (or the agent) can tell it apart. */
export const RENDER_CHECK_REFUSAL_LEAD = 'Rejection: this candidate failed the render check';

/**
 * The refusal for a candidate that fails the render check, or null when it
 * passes. Run it before the marker checks: a truncated document has usually
 * lost its Sources section too, and "reference S1 matches no Sources entry"
 * would send the agent after the wrong fix.
 *
 * Stateless on purpose: the agent sees its earlier refusals in the thread, so
 * the "second failure on the same instruction" rule is carried by the text.
 */
export function insightStructureRefusal(
  html: string,
  audience: CandidateAudience,
): string | null {
  const reason = checkInsightTruncation(html);
  if (!reason) return null;

  const lead = `${RENDER_CHECK_REFUSAL_LEAD}: ${reason}`;
  switch (audience) {
    case 'edit-proposal':
      return `${lead} Nothing was offered to the user, and the insight's current version stays the current version — nothing changed. Tell the user this edit could not be rendered and give the reason above in one or two plain sentences. If an earlier attempt at this same instruction was already refused in this conversation, do not try again: suggest the user rephrase the instruction or narrow the change (for example, one section or one table at a time). Otherwise you may retry once with the complete document.`;
    case 'create-proposal':
      return `${lead} Nothing was offered to the user and no insight was created. Tell the user the insight could not be rendered and give the reason above in one or two plain sentences. If an earlier attempt at this same request was already refused in this conversation, do not try again: suggest the user rephrase the request or narrow it (for example, fewer sections, or a smaller table). Otherwise you may retry once with the complete document.`;
    case 'workforce-create':
      return `${lead} Nothing was written and no insight was created. Write the complete document again. If the same write fails the check a second time, stop and report the failure and its reason in your final report, suggesting the task be narrowed (for example, a skeleton first, then one section per edit_insight_section call).`;
    case 'workforce-section':
      return `${RENDER_CHECK_REFUSAL_LEAD} (in the section fragment): ${reason} Nothing was written, and the insight's current version stays the current version. Write the complete fragment again. If the same write fails the check a second time, stop and report the failure and its reason in your final report, suggesting the section be narrowed.`;
    case 'workforce-document':
    default:
      return `${lead} Nothing was written, and the insight's current version stays the current version. Write the complete document again. If the same write fails the check a second time, stop and report the failure and its reason in your final report, suggesting the task be narrowed (for example, one section per edit_insight_section call).`;
  }
}
