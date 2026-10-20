import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { readConfiguredAgentStamp } from '@/lib/insights/agentStamp';
import type { InsightKind } from '@/lib/insights/types';
import {
  insightCreateSchema,
  validateInsightCreate,
} from '@/lib/insights/toolValidation';
import { insightLayoutNote } from '@/lib/insights/layoutCheck';
import { readInsightRunContext } from '@/lib/insights/refreshRun';
import { insightMarkerRefusal } from '@/lib/agents/sector/evidenceMarkers';

export const createInsight = tool(
  async (
    {
      name,
      description,
      html,
      kind = 'document',
      template_id,
    }: {
      name: string;
      description?: string;
      html: string;
      kind?: InsightKind;
      template_id?: string;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug('🔧 TOOL CALLED: create_insight()');

    const ctx = readInsightRunContext(runtime?.configurable);
    if (ctx.refreshInsightId) {
      return `Rejection: This run is a scheduled refresh of insight ${ctx.refreshInsightId}; it cannot create new insights. Edit that insight with edit_insight_section or replace_insight_document.`;
    }

    // The render check (MB-555) runs before the marker checks.
    const validation = validateInsightCreate(name, html, kind, 'workforce-create');
    if ('error' in validation) {
      return validation.error;
    }
    const { name: trimmedName, html: trimmedHtml } = validation;

    // Every write must carry well-formed source references, Sources entries and
    // unavailable cells (MB-551/556); a @dikti write also well-formed evidence
    // markers (MB-543).
    const markerRefusal = insightMarkerRefusal(trimmedHtml, runtime?.configurable?.agent_key);
    if (markerRefusal) {
      return markerRefusal;
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

      const created = await insightService.createFromDocument({
        workspaceId,
        name: trimmedName,
        description: description?.trim() || null,
        html: trimmedHtml,
        userId,
        kind,
        agentStamp: readConfiguredAgentStamp(runtime?.configurable),
        // Recorded as the insight's source template when it is a live template
        // in this workspace; the create never fails over it.
        templateId: template_id ?? null,
        // Lets the run's completion email link to the insight it produced.
        sourceRunId: ctx.runId,
      });

      const layoutNote = insightLayoutNote(trimmedHtml, 'workforce-create');
      const createdLine = `Created insight **${created.name}** — [open it](/insight/${created.id})`;
      return layoutNote ? `${createdLine}\n\n${layoutNote}` : createdLine;
    } catch (err) {
      logger.error(
        `Failed to create insight "${trimmedName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return `**Error:** Failed to create insight: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
  {
    name: 'create_insight',
    description: `Create a NEW insight directly in the workspace.

Writes and publishes version 1 of the insight immediately without requiring an interactive approval card. Used in AI Workforce runs where the overall task was already authorized by the user.

For reports and large documents, author the initial skeleton first with empty or outline data-section keyed blocks (a report skeleton has empty summary, details, and appendix sections in that order), then call edit_insight_section on subsequent turns to fill them in one section per turn.

When the insight is built on an insight template, pass its template_id so the insight records which template it came from.`,
    schema: insightCreateSchema,
  },
);
