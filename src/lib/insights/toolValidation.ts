import { z } from 'zod';
import type { InsightKind } from '@/lib/insights/types';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import {
  insightStructureRefusal,
  type CandidateAudience,
} from '@/lib/insights/structuralCheck';
import { sanitizePageContext } from '@/lib/chat/pageContext';
import { isUuid } from '@/lib/uuid';

export const MAX_INSIGHT_NAME_LENGTH = 120;

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
