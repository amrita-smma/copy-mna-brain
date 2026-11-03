import { z } from 'zod';
import type { InsightKind } from '@/lib/insights/types';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import {
  insightStructureRefusal,
  type CandidateAudience,
} from '@/lib/insights/structuralCheck';
import { sanitizePageContext } from '@/lib/chat/pageContext';
import { isUuid } from '@/lib/uuid';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/srcdoc';
import {
  findInsightSection,
  listInsightSectionKeys,
  replaceInsightSection,
} from '@/lib/insights/sectionEdit';


export const insightKindSchema = z
  .enum(['document', 'report'])
  .describe(
    "Use 'report' for an analytical report that must follow the three-section contract; 'document' for a dashboard or interactive tool.",
  );

export const insightCreateSchema = z.object({
  name: z
    .string()
    .describe('Short name for the new insight, as it appears in the list'),
  description: z
    .string()
    .optional()
    .describe('One sentence describing what the insight covers'),
  html: z
    .string()
    .describe('The complete HTML document skeleton or full document'),
  kind: insightKindSchema.optional().default('document'),
  // Not .uuid(): a failed parse makes the model resend the whole document.
  // The create drops anything that is not a live template's uuid.
  template_id: z
    .string()
    .optional()
    .describe(
      'The template_id (a uuid) of the insight template the document was built on, if any, so the insight records which template it came from',
    ),
});

/**
 * The checks every candidate document clears before it is proposed or
 * written. With an `audience`, the MB-555 render check runs first (before the
 * size, placeholder and report-contract guard, whose "fix and retry" wording
 * would misdirect an agent whose document was cut off), and its refusal tells
 * the agent what to report and when to stop retrying.
 */
export function validateInsightDocument(
  html: string,
  kind?: InsightKind,
  audience?: CandidateAudience,
): { error: string } | { html: string } {
  const trimmedHtml = html?.trim() ?? '';
  if (!trimmedHtml) {
    return { error: 'Rejection: No HTML document provided.' };
  }

  if (audience) {
    const structure = insightStructureRefusal(trimmedHtml, audience);
    if (structure) {
      return { error: structure };
    }
  }

  const rejection = rejectInvalidInsightDocument(trimmedHtml, kind);
  if (rejection) {
    return { error: `Rejection: ${rejection}` };
  }

  return { html: trimmedHtml };
}

export function validateInsightCreate(
  name: string,
  html: string,
  kind?: InsightKind,
  audience?: CandidateAudience,
): { error: string } | { name: string; html: string } {
  const trimmedName = name?.trim() ?? '';
  if (!trimmedName) {
    return { error: 'Rejection: An insight name is required.' };
  }
  if (trimmedName.length > MAX_INSIGHT_NAME_LENGTH) {
    return {
      error: `Rejection: Insight name is longer than ${MAX_INSIGHT_NAME_LENGTH} characters.`,
    };
  }

  const doc = validateInsightDocument(html, kind, audience);
  if ('error' in doc) {
    return doc;
  }

  return { name: trimmedName, html: doc.html };
}

export function resolveInsightId(
  action: 'read insight' | 'propose insight edit' | 'propose insight refresh',
  insightId?: string,
  pageContextRaw?: unknown,
): { error: string } | { id: string } {
  const pageContext = sanitizePageContext(pageContextRaw);
  const pageContextInsightId = (pageContext as { insightId?: string } | null)?.insightId;
  const resolvedId = insightId?.trim() || pageContextInsightId;

  if (!resolvedId) {
    return {
      error: `Cannot ${action}: no insight is currently open in page context. Open an insight or provide insight_id.`,
    };
  }

  if (!isUuid(resolvedId)) {
    return {
      error: `Rejection: insight_id "${resolvedId}" is not a valid UUID.`,
    };
  }

  return { id: resolvedId };
}

/** The only shape a section key may take — the same as a page-context ref's key. */
const SECTION_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** The section key a tool argument names, or the refusal for one it cannot name. */
export function validateSectionKey(section: string): { error: string } | { key: string } {
  const key = section?.trim() ?? '';
  if (!key) {
    return { error: 'Rejection: A section key is required.' };
  }
  if (!SECTION_KEY_RE.test(key)) {
    return {
      error: `Rejection: section "${key}" is not a data-section key. Keys match [A-Za-z0-9_-]+ — pass the key exactly as it appears in the document's data-section attribute.`,
    };
  }
  return { key };
}

export interface SectionEditCandidate {
  /** The fragment, trimmed. */
  fragment: string;
  /** The whole document with the fragment spliced over the section. */
  html: string;
}

/**
 * The checks a section-scoped edit proposal clears before a card is offered:
 * the fragment renders on its own (truncation), the section exists exactly
 * once in the current document, the spliced document passes every
 * whole-document check (size, placeholder, nesting, the report contract), and
 * the fragment kept its `data-section` key — a block that loses its key can no
 * longer be pointed at by the reader or edited by section again.
 *
 * Only the fragment reaches the model in and out; the splice happens here
 * against the document read from the database, and again on the server when
 * the card is approved. A refusal names the fix for the fragment, never a
 * reason to resend the whole document.
 */
export function validateInsightSectionEdit(
  currentHtml: string,
  section: string,
  fragment: string,
  kind?: InsightKind,
): { error: string } | SectionEditCandidate {
  const trimmedFragment = fragment?.trim() ?? '';
  if (!trimmedFragment) {
    return { error: 'Rejection: No HTML fragment provided for the section.' };
  }

  const structure = insightStructureRefusal(trimmedFragment, 'edit-section-proposal');
  if (structure) {
    return { error: structure };
  }

  const spliced = replaceInsightSection(currentHtml, section, trimmedFragment);
  if (!spliced.success) {
    const keys = listInsightSectionKeys(currentHtml);
    const known = keys.length > 0 ? ` The document's data-section keys are: ${keys.map((k) => `"${k}"`).join(', ')}.` : ' The document has no data-section keys, so it cannot be edited by section — propose the whole document instead.';
    return { error: `Rejection: ${spliced.error}${known}` };
  }

  const splicedHtml = spliced.html.trim();
  const rejection = rejectInvalidInsightDocument(splicedHtml, kind);
  if (rejection) {
    return { error: `Rejection: ${rejection} (The fragment was spliced into the current document for this check; fix the fragment and resend only it.)` };
  }

  const kept = findInsightSection(splicedHtml, section);
  if (!kept.success) {
    return {
      error: `Rejection: after the edit, ${kept.error.replace(/\.$/, '')}. The fragment must keep data-section="${section}" on exactly one element — its root — so the reader can still point at the block and later edits can still target it. Resend only the fragment with that attribute kept.`,
    };
  }

  return { fragment: trimmedFragment, html: splicedHtml };
}
