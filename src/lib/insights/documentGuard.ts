/**
 * Guards insight HTML arguments against placeholder text or sandbox file references.
 * Ensures the document contains at least one HTML tag, accepting any renderable
 * HTML fragment without imposing artificial length thresholds.
 */

import { MAX_INSIGHT_BYTES } from '@/lib/insights/srcdoc';
import { validateReportStructure } from '@/lib/insights/reportStructure';
import { rejectTooDeeplyNested } from '@/lib/insights/parseHtml';
import type { InsightKind } from '@/lib/insights/types';

/** The first `<tag`, `</tag`, `<!doctype` or `<!--` in the document. */
const HTML_TAG_RE = /<\s*(?:!|\/?[a-z])/i;

/**
 * Returns a rejection message when `html` cannot be an insight document, or
 * `null` when it passes. The message is written to the model, so it names the
 * mistake and the fix rather than just refusing.
 */
export function rejectPlaceholderDocument(html: string): string | null {
  if (HTML_TAG_RE.test(html)) return null;
  return (
    'The `html` argument contains no HTML — it looks like a placeholder or a ' +
    'reference to a file rather than the document itself. This tool takes the ' +
    'insight BY VALUE: paste the complete HTML document into `html` in this ' +
    'call. A file you wrote in a code-execution sandbox is not readable from ' +
    'here, so there is nothing to read back.'
  );
}

/**
 * Every check a model-authored document must clear before it is proposed or
 * written: size, the placeholder guard above, and — for a report — the
 * structural contract.
 *
 * All four insight tools share it on purpose. The chat pair proposes and the
 * workforce pair writes directly; if the two lists drifted, the model could
 * write through one path a document the other refuses. Returns the sentence to
 * show the model, or null when the document passes.
 */
export function rejectInvalidInsightDocument(
  html: string,
  kind?: InsightKind,
): string | null {
  if (Buffer.byteLength(html, 'utf8') > MAX_INSIGHT_BYTES) {
    return `HTML document exceeds maximum size of ${MAX_INSIGHT_BYTES} bytes.`;
  }

  const placeholder = rejectPlaceholderDocument(html);
  if (placeholder) return placeholder;

  const tooDeep = rejectTooDeeplyNested(html);
  if (tooDeep) return tooDeep;

  if (kind === 'report') return validateReportStructure(html);

  return null;
}
