import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { readConfiguredAgentStamp } from '@/lib/insights/agentStamp';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import { insightStructureRefusal } from '@/lib/insights/structuralCheck';
import { insightLayoutNote } from '@/lib/insights/layoutCheck';
import { MAX_INSIGHT_BYTES } from '@/lib/insights/srcdoc';
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

export const replaceInsightDocument = tool(
  async (
    {
      insight_id,
      html,
      summary,
    }: {
      insight_id: string;
      html: string;
      summary?: string;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug(
      `🔧 TOOL CALLED: replace_insight_document(insight_id='${insight_id}')`,
    );

    const resolvedId = insight_id?.trim();
    if (!resolvedId) {
      return 'Rejection: An insight_id is required.';
    }
    if (!isUuid(resolvedId)) {
      return `Rejection: insight_id "${resolvedId}" is not a valid UUID.`;
    }

    const trimmedHtml = html?.trim() ?? '';
    if (!trimmedHtml) {
      return 'Rejection: No HTML document provided.';
    }

    if (Buffer.byteLength(trimmedHtml, 'utf8') > MAX_INSIGHT_BYTES) {
      return `Rejection: HTML document exceeds maximum size of ${MAX_INSIGHT_BYTES} bytes.`;
    }

    // The render check (MB-555) runs before the marker checks: a truncated
    // document has usually lost its Sources section too.
    const structureRefusal = insightStructureRefusal(trimmedHtml, 'workforce-document');
    if (structureRefusal) {
      return structureRefusal;
    }

    // Every write must carry well-formed source references, Sources entries and
    // unavailable cells (MB-551/556); a @dikti write also well-formed evidence
    // markers (MB-543).
    const markerRefusal = insightMarkerRefusal(trimmedHtml, runtime?.configurable?.agent_key);
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
      const { insightService } = createContainer(db, workspaceId);

      // In a scheduled refresh run, apply the document edit to the run's draft.
      if (ctx.refreshInsightId) {
        const result = await insightService.applyRunDraftEdit({
          workspaceId,
          runId: ctx.runId ?? '',
          insightId: resolvedId,
          edit: {
            kind: 'document',
            html: trimmedHtml,
          },
        });

        const draftLine = `Replaced the document of insight **${result.insightName}** in this refresh run's draft (based on version ${result.baseVersionNo}). Nothing is published until the run completes.`;
        const draftNote = insightLayoutNote(trimmedHtml, 'workforce-document');
        return draftNote ? `${draftLine}\n\n${draftNote}` : draftLine;
      }

      const current = await insightService.get(workspaceId, resolvedId);

      const rejection = rejectInvalidInsightDocument(trimmedHtml, current.kind);
      if (rejection) {
        return `Rejection: ${rejection}`;
      }

      const updated = await insightService.publishVersion({
        workspaceId,
        insightId: resolvedId,
        html: trimmedHtml,
        label: summary?.trim() || null,
        userId,
        baseVersionNo: current.version_no,
        trigger: 'workforce',
        sourceRunId: ctx.runId,
        agentStamp: readConfiguredAgentStamp(runtime?.configurable),
      });

      const replacedLine = `Replaced the document of insight **${updated.name}** (version ${updated.version_no}) — [open it](/insight/${updated.id})`;
      const layoutNote = insightLayoutNote(trimmedHtml, 'workforce-document');
      return layoutNote ? `${replacedLine}\n\n${layoutNote}` : replacedLine;
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
        `Failed to replace insight document in "${resolvedId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return `**Error:** Failed to replace insight document: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
  {
    name: 'replace_insight_document',
    description: `Replace the complete HTML document of an existing insight.

Useful for updating an entire insight at once (e.g. one without data-section markup, or when restructuring the entire document), publishing a new version directly (no approval card needed in AI Workforce runs).

In a scheduled refresh run, edits go to the run's draft and nothing is live until the run completes (published once as a single version).`,
    schema: z.object({
      insight_id: z.string().describe('UUID of the insight to edit'),
      html: z.string().describe('The complete replacement HTML document'),
      summary: z
        .string()
        .optional()
        .describe('One sentence summarizing what was replaced or updated'),
    }),
  },
);
