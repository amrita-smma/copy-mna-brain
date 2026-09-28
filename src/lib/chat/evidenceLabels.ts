/**
 * Detects the sector agents' chat evidence forms (MB-542, MB-543) in the
 * markdown tree react-markdown hands its components, so the CoPilot can style
 * a guardrail as a callout and the Observed / Inferred / Modelled labels as
 * pills. Pure: `MarkdownRenderer` only maps the result to markup.
 *
 * Only the pinned forms match (see `sector/evidenceMarkers.ts`):
 *   - a paragraph (or list item) whose first content is a bold `Data limit:`;
 *   - a bold run whose entire text is `Observed`, `Inferred` or `Modelled`,
 *     with an optional trailing colon.
 * Anything else — the word "Observed" mid-sentence, a bold phrase that merely
 * contains it, a `Data limit:` that is not the paragraph's lead — stays plain.
 */
import {
  CHAT_DATA_LIMIT_LEAD,
  CHAT_EVIDENCE_LABELS,
  type ChatEvidenceLabel,
} from '@/lib/agents/sector/evidenceMarkers';

/** The slice of a hast node this module reads. */
export interface MarkdownTreeNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: MarkdownTreeNode[];
}

function textOf(node: MarkdownTreeNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function isBlankText(node: MarkdownTreeNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim();
}

function isStrong(node: MarkdownTreeNode | undefined): node is MarkdownTreeNode {
  return node?.type === 'element' && node.tagName === 'strong';
}

/**
 * True when `node` is a `<p>` — or an `<li>`, since a guardrail in a tight
 * bullet list has no paragraph — that opens with a bold `Data limit:`.
 * In a loose list the `<li>` wraps a `<p>`; the `<p>` matches, not the `<li>`.
 */
export function isDataLimitBlock(node: MarkdownTreeNode | undefined): boolean {
  if (!node || node.type !== 'element') return false;
  if (node.tagName !== 'p' && node.tagName !== 'li') return false;
  const first = (node.children ?? []).find((c) => !isBlankText(c));
  return isStrong(first) && textOf(first).trim() === CHAT_DATA_LIMIT_LEAD;
}

const LABEL_BY_TEXT = new Map<string, ChatEvidenceLabel>(
  (Object.entries(CHAT_EVIDENCE_LABELS) as [ChatEvidenceLabel, string][]).map(([k, v]) => [v, k]),
);

/** The evidence label a bold run spells exactly, or null. */
export function evidenceLabelOf(node: MarkdownTreeNode | undefined): ChatEvidenceLabel | null {
  if (!isStrong(node)) return null;
  const text = textOf(node).trim().replace(/:$/, '');
  return LABEL_BY_TEXT.get(text) ?? null;
}
