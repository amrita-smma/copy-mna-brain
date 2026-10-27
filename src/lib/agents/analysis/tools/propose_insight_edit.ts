import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { DEFER_LOADING } from './server_tools';
import type { InsightEditApprovalMarker, InsightKind } from '@/lib/insights/types';
import {
  INSIGHT_EDIT_APPROVAL_MARKER,
  encodeApprovalMarker,
} from '@/lib/insights/approvalMarker';
import {
  insightKindSchema,
  resolveInsightId,
  validateInsightDocument,
} from '@/lib/insights/toolValidation';
import { insightLayoutNote } from '@/lib/insights/layoutCheck';
import { insightMarkerRefusal } from '@/lib/agents/sector/evidenceMarkers';

export { INSIGHT_EDIT_APPROVAL_MARKER };

export const proposeInsightEdit = tool(
  async (
    {
      insight_id,
      html,
      summary,
      kind,
    }: {
      insight_id?: string;
      html: string;
      summary: string;
      kind?: InsightKind;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug('🔧 TOOL CALLED: propose_insight_edit()');

    const resolution = resolveInsightId(
      'propose insight edit',
      insight_id,
      runtime?.configurable?.pageContext,
    );
    if ('error' in resolution) {
      return resolution.error;
    }
    const resolvedInsightId = resolution.id;

    const trimmedSummary = summary?.trim() ?? '';
    if (!trimmedSummary) {
      return 'Rejection: An edit summary is required.';
    }

    // The render check (MB-555) runs first, so a truncated candidate is never
    // offered and the refusal tells the agent to report it to the user.
    const doc = validateInsightDocument(html, kind, 'edit-proposal');
    if ('error' in doc) {
      return doc.error;
    }

    // Every write must carry well-formed source and unavailable markers
    // (MB-551/556), a @dikti write also evidence markers (MB-543). The
    // approval card writes this HTML as-is, so check it here, where the agent
    // can still fix it.
    const markerRefusal = insightMarkerRefusal(doc.html, runtime?.configurable?.agent_key);
    if (markerRefusal) {
      return markerRefusal;
    }

    const payload: InsightEditApprovalMarker = {
      approval_id: randomUUID(),
      insight_id: resolvedInsightId,
      summary: trimmedSummary,
    };

    const layoutNote = insightLayoutNote(doc.html, 'edit-proposal');
    const lines = [
      `Insight edit proposal: **${payload.summary}**`,
      '',
      `Target insight: \`${payload.insight_id}\``,
      '',
      ...(layoutNote ? [layoutNote, ''] : []),
      encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, payload),
    ];

    return lines.join('\n');
  },
  {
    name: 'propose_insight_edit',
    description: `Propose an edit to an existing insight via an approval card.

Calling this tool does NOT write anything to the database. It renders an
approval card for the user to inspect and approve; approving creates a new
version and updates the insight.

Provide the complete updated HTML document (the whole document, not a partial diff
or section fragment) and a brief summary of the changes made. Read the current
document with get_insight first — everything you leave out is deleted.

When page context names a selected section, that is the part the user means:
change only the block with that data-section key and reproduce the rest of the
document byte-identically. Keep each major block's data-section="kebab-key"
attribute intact, and add one to any block you introduce, or the reader can no
longer click it.

Defaults to the active insight in page context.`,
    schema: z.object({
      insight_id: z
        .string()
        .optional()
        .describe(
          'Target insight UUID. Defaults to the active insight in page context.',
        ),
      html: z
        .string()
        .describe('The complete updated HTML document'),
      summary: z
        .string()
        .describe('Brief summary of the changes made'),
      kind: insightKindSchema.optional(),
    }),
    // Rare on a typical turn: loaded on demand through the tool-search
    // server tool (see `server_tools.ts`).
    extras: DEFER_LOADING,
  },
);
