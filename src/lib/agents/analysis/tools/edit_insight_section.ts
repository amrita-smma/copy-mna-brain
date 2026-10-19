import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { readConfiguredAgentStamp } from '@/lib/insights/agentStamp';
import { replaceInsightSection } from '@/lib/insights/sectionEdit';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import { insightStructureRefusal } from '@/lib/insights/structuralCheck';
import { insightLayoutNote } from '@/lib/insights/layoutCheck';
import {
  InsightNotFoundError,
  InsightPayloadTooLargeError,
  InsightValidationError,
  StaleInsightVersionError,
} from '@/lib/services/insightService';
import {
  readInsightRunContext,
  refreshRunWriteRefusal,
} from '@/lib/insights/refreshRun';
import { isUuid } from '@/lib/uuid';
import { insightMarkerRefusal } from '@/lib/agents/sector/evidenceMarkers';

export const editInsightSection = tool(
  async (
    {
      insight_id,
      section,
      html,
      summary,
    }: {
      insight_id: string;
      section: string;
      html: string;
      summary?: string;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug(
      `🔧 TOOL CALLED: edit_insight_section(insight_id='${insight_id}', section='${section}')`,
    );

    const resolvedId = insight_id?.trim();
    if (!resolvedId) {
      return 'Rejection: An insight_id is required.';
    }
    if (!isUuid(resolvedId)) {
      return `Rejection: insight_id "${resolvedId}" is not a valid UUID.`;
    }

    const trimmedSection = section?.trim() ?? '';
    if (!trimmedSection) {
      return 'Rejection: A section key is required.';
    }

    const trimmedFragment = html?.trim() ?? '';
    if (!trimmedFragment) {
      return 'Rejection: No HTML fragment provided.';
    }

    // The render check (MB-555) on the fragment, before the marker checks: a
    // cut-off fragment (an unterminated comment, an unclosed <script>) would
    // otherwise be spliced into the document or the refresh run's draft.
    const structureRefusal = insightStructureRefusal(trimmedFragment, 'workforce-section');
    if (structureRefusal) {
      return structureRefusal;
    }

    // Every write must carry well-formed source references, Sources entries and
    // unavailable cells (MB-551/556); a @dikti write also well-formed evidence
    // markers (MB-543). Only the fragment is checked here — its references may
    // resolve to entries elsewhere, which the service checks after the splice.
    const markerRefusal = insightMarkerRefusal(
      trimmedFragment,
      runtime?.configurable?.agent_key,
      'fragment',
    );
    if (markerRefusal) {
      return markerRefusal;
    }

    const ctx = readInsightRunContext(runtime?.configurable);
    const refusal = refreshRunWriteRefusal(ctx, resolvedId);
    if (refusal) {
      return refusal;
    }

    const userId =
      (runtime?.configurable?.triggered_by_user_id as string | undefined) ?? null;

    try {
      const workspaceId = await getActiveWorkspaceIdOrThrow();
      const db = createDb();
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import('@/lib/services/container');
      const { insightService } = createContainer(db, workspaceId);

      // In a scheduled refresh run, apply the edit to the run's draft.
      if (ctx.refreshInsightId) {
        const result = await insightService.applyRunDraftEdit({
          workspaceId,
          runId: ctx.runId ?? '',
          insightId: resolvedId,
          edit: {
            kind: 'section',
            section: trimmedSection,
            html: trimmedFragment,
          },
        });

        return `Updated section "${trimmedSection}" of insight **${result.insightName}** in this refresh run's draft (based on version ${result.baseVersionNo}). Nothing is published until the run completes.`;
      }

      const current = await insightService.get(workspaceId, resolvedId);

      // Splice section into the existing document
      const spliceResult = replaceInsightSection(
        current.html,
        trimmedSection,
        trimmedFragment,
      );
      if (!spliceResult.success) {
        return `Rejection: ${spliceResult.error}`;
      }

      const splicedHtml = spliceResult.html.trim();
      if (!splicedHtml) {
        return 'Rejection: Spliced HTML document is empty.';
      }

      const rejection = rejectInvalidInsightDocument(splicedHtml, current.kind);
      if (rejection) {
        return `Rejection: ${rejection}`;
      }

      const updated = await insightService.publishVersion({
        workspaceId,
        insightId: resolvedId,
        html: splicedHtml,
        label: summary?.trim() || null,
        userId,
        baseVersionNo: current.version_no,
        trigger: 'workforce',
        sourceRunId: ctx.runId,
        agentStamp: readConfiguredAgentStamp(runtime?.configurable),
      });

      const updatedLine = `Updated section "${trimmedSection}" of insight **${updated.name}** (version ${updated.version_no}) — [open it](/insight/${updated.id})`;
      const layoutNote = insightLayoutNote(splicedHtml, 'workforce-section', current.html);
      return layoutNote ? `${updatedLine}\n\n${layoutNote}` : updatedLine;
    } catch (err) {
      if (
        err instanceof InsightValidationError ||
        err instanceof InsightPayloadTooLargeError ||
        err instanceof InsightNotFoundError ||
        err instanceof StaleInsightVersionError
      ) {
        return `Rejection: ${err.message}`;
      }
      logger.error(
        `Failed to edit insight section "${trimmedSection}" in "${resolvedId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return `**Error:** Failed to edit insight section: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
  {
    name: 'edit_insight_section',
    description: `Update a single section within an existing insight by replacing its HTML fragment.

Replaces the element carrying data-section="<section>" with the provided fragment, validates the resulting spliced document, and publishes a new version directly (no approval card needed in AI Workforce runs).

Allows large documents and reports to be built incrementally, one section per turn, avoiding timeouts. In a scheduled refresh run, edits go to the run's draft and nothing is live until the run completes (published once as a single version).`,
    schema: z.object({
      insight_id: z.string().describe('UUID of the insight to edit'),
      section: z
        .string()
        .describe(
          'The data-section key of the block to replace (e.g. "market-overview")',
        ),
      html: z
        .string()
        .describe(
          'The replacement HTML fragment for that section (including tags)',
        ),
      summary: z
        .string()
        .optional()
        .describe('One sentence summarizing what was updated in this section'),
    }),
  },
);
