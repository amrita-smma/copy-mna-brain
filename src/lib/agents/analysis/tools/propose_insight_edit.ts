import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { DEFER_LOADING } from './server_tools';
import { INSIGHT_EDIT_AUTHORING_RULES } from '../guides';
import type { InsightEditApprovalMarker, InsightKind } from '@/lib/insights/types';
import {
  INSIGHT_EDIT_APPROVAL_MARKER,
  encodeApprovalMarker,
} from '@/lib/insights/approvalMarker';
import {
  insightKindSchema,
  resolveInsightId,
  validateInsightDocument,
  validateInsightSectionEdit,
  validateSectionKey,
} from '@/lib/insights/toolValidation';
import { insightLayoutNote } from '@/lib/insights/layoutCheck';
import { insightStructureRefusal } from '@/lib/insights/structuralCheck';
import { insightMarkerRefusal } from '@/lib/agents/sector/evidenceMarkers';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';

export { INSIGHT_EDIT_APPROVAL_MARKER };

/** The current version of the insight a section edit is spliced into, or why it could not be read. */
async function readCurrentDocument(
  insightId: string,
): Promise<{ error: string } | { html: string; kind: InsightKind | null | undefined }> {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    // Resolved lazily to keep this tool off the container's static import
    // cycle (see TECH_DEBT.md "Runtime import cycle").
    const { createContainer } = await import('@/lib/services/container');
    const { insightService } = createContainer(db, workspaceId);
    const detail = await insightService.get(workspaceId, insightId);
    return { html: detail.html, kind: detail.kind };
  } catch (err) {
    logger.error(
      `propose_insight_edit: could not read insight "${insightId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { error: `Rejection: Insight "${insightId}" could not be read in this workspace, so there is no document to splice the section into.` };
  }
}

export const proposeInsightEdit = tool(
  async (
    {
      insight_id,
      section,
      html,
      summary,
      kind,
    }: {
      insight_id?: string;
      section?: string;
      html: string;
      summary: string;
      kind?: InsightKind;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug(
      `🔧 TOOL CALLED: propose_insight_edit(${section ? `section='${section}'` : 'whole document'})`,
    );

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

    const agentKey = runtime?.configurable?.agent_key;

    // ── Section-scoped edit: the fragment is checked on its own, then spliced
    // into the current document and the result checked as a whole, so the
    // model hears about a bad fragment now and the user never sees a card
    // that cannot publish. Only the fragment travels in the payload.
    if (section !== undefined && section !== null && section.trim() !== '') {
      const key = validateSectionKey(section);
      if ('error' in key) {
        return key.error;
      }

      // The fragment's own render check first (MB-555): a cut-off fragment
      // is refused before anything is read, and the refusal says to resend
      // the fragment, never the document.
      const trimmedFragment = html?.trim() ?? '';
      if (!trimmedFragment) {
        return 'Rejection: No HTML fragment provided for the section.';
      }
      const fragmentStructure = insightStructureRefusal(trimmedFragment, 'edit-section-proposal');
      if (fragmentStructure) {
        return fragmentStructure;
      }

      const current = await readCurrentDocument(resolvedInsightId);
      if ('error' in current) {
        return current.error;
      }

      const candidate = validateInsightSectionEdit(
        current.html,
        key.key,
        html,
        kind ?? current.kind ?? undefined,
      );
      if ('error' in candidate) {
        return candidate.error;
      }

      // The fragment's own markers first (a @dikti fragment's evidence
      // markers, MB-543), then the spliced document's: a [S1] in the fragment
      // must resolve to a Sources entry somewhere in the document.
      const fragmentRefusal = insightMarkerRefusal(candidate.fragment, agentKey, 'fragment');
      if (fragmentRefusal) {
        return fragmentRefusal;
      }
      const documentRefusal = insightMarkerRefusal(candidate.html, agentKey);
      if (documentRefusal) {
        return documentRefusal;
      }

      const payload: InsightEditApprovalMarker = {
        approval_id: randomUUID(),
        insight_id: resolvedInsightId,
        summary: trimmedSummary,
        section: key.key,
      };

      const layoutNote = insightLayoutNote(candidate.html, 'edit-proposal', current.html);
      return [
        `Insight section edit proposal: **${payload.summary}**`,
        '',
        `Target insight: \`${payload.insight_id}\``,
        `Section: \`${key.key}\` (${candidate.fragment.length.toLocaleString('en-US')} characters; the rest of the document is unchanged)`,
        '',
        ...(layoutNote ? [layoutNote, ''] : []),
        encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, payload),
      ].join('\n');
    }

    // ── Whole-document edit.
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
    const markerRefusal = insightMarkerRefusal(doc.html, agentKey);
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

PREFER A SECTION EDIT. When the change is confined to one data-section block
— the block the user selected, or the one the request plainly concerns — pass
\`section\` (its data-section key) and put ONLY that block's complete
replacement fragment in \`html\`: the outer element with its
data-section="<key>" attribute kept, and everything inside it. Read just that
block first with get_insight(section: "<key>"). The server splices the
fragment over the block in the current version and leaves every other byte of
the document untouched, so the document never has to pass through you. Keep
the key on the fragment's root element; a fragment that drops it is refused.
A section edit works on an insight of any size, including one too large to
read whole in chat.

Otherwise — a change that touches several blocks, restructures the document,
or edits a document with no data-section keys — omit \`section\` and provide
the complete updated HTML document (the whole document, not a partial diff or
fragment) and a brief summary of the changes made. Read the current document
with get_insight first — everything you leave out is deleted.

Keep each major block's data-section="kebab-key" attribute intact, and add one
to any block you introduce, or the reader can no longer click it.

Defaults to the active insight in page context.

${INSIGHT_EDIT_AUTHORING_RULES}`,
    schema: z.object({
      insight_id: z
        .string()
        .optional()
        .describe(
          'Target insight UUID. Defaults to the active insight in page context.',
        ),
      section: z
        .string()
        .optional()
        .describe(
          'The data-section key of the ONE block this edit replaces (e.g. "market-overview"). When set, `html` is that block\'s replacement fragment, not a document. Omit for a whole-document edit.',
        ),
      html: z
        .string()
        .describe(
          'With `section`: the complete replacement fragment for that block, its data-section attribute kept. Without: the complete updated HTML document.',
        ),
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
