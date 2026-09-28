import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { resolveInsightId } from '@/lib/insights/toolValidation';
import { readInsightRunContext } from '@/lib/insights/refreshRun';
import { isTooLargeForChat } from '@/lib/insights/templateAttachment';
import { formatLargeInsightForChat } from '@/lib/insights/largeDocument';

export const MAX_INSIGHT_READ_CHARS = 60000;

/** True in an AI Workforce run (runAgent sets `agentRole: 'workforce'` and a `run_id`); chat reads as chat. */
function isWorkforceRun(runtime: RunnableConfig | undefined, runId: string | null): boolean {
  return runtime?.configurable?.agentRole === 'workforce' || runId !== null;
}

export const getInsight = tool(
  async ({ insight_id }: { insight_id?: string }, runtime?: RunnableConfig) => {
    logger.debug('🔧 TOOL CALLED: get_insight()');

    const ctx = readInsightRunContext(runtime?.configurable);
    const rawId = insight_id?.trim() || undefined;
    const effectiveInsightId = rawId ?? (ctx.refreshInsightId ?? undefined);

    const resolution = resolveInsightId(
      'read insight',
      effectiveInsightId,
      runtime?.configurable?.pageContext,
    );
    if ('error' in resolution) {
      return resolution.error;
    }
    const resolvedId = resolution.id;

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    try {
      const detail = await insightService.get(workspaceId, resolvedId);

      let isDraft = false;
      let baseVersionNo = detail.version_no;
      let rawHtml = detail.html;

      if (ctx.refreshInsightId && resolvedId === ctx.refreshInsightId && ctx.runId) {
        const draft = await insightService.getRunDraft(workspaceId, ctx.runId);
        if (draft && draft.insight_id === resolvedId) {
          isDraft = true;
          baseVersionNo = draft.base_version_no;
          rawHtml = draft.html;
        }
      }

      // Chat edits with propose_insight_edit, which carries the whole document:
      // one call that size cannot finish inside a chat turn's budget, so chat
      // gets an outline and the instruction to hand the edit to the Workforce.
      if (!isWorkforceRun(runtime, ctx.runId) && isTooLargeForChat(rawHtml)) {
        const header = [
          `Insight: ${detail.name} (id ${detail.id}, version ${detail.version_no})`,
          detail.kind ? `Kind: ${detail.kind}` : '',
          `Length: ${rawHtml.length.toLocaleString('en-US')} characters`,
          detail.description ? `Description: ${detail.description}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return `${header}\n\n${formatLargeInsightForChat({ id: detail.id, name: detail.name, html: rawHtml })}`;
      }

      const truncated = rawHtml.length > MAX_INSIGHT_READ_CHARS;
      const html = truncated
        ? rawHtml.slice(0, MAX_INSIGHT_READ_CHARS)
        : rawHtml;

      const header = isDraft
        ? `Insight: ${detail.name} (id ${detail.id}, unpublished draft for this refresh run, based on version ${baseVersionNo})`
        : `Insight: ${detail.name} (id ${detail.id}, version ${detail.version_no})`;

      return [
        header,
        detail.kind ? `Kind: ${detail.kind}` : '',
        `Length: ${rawHtml.length.toLocaleString('en-US')} characters`,
        detail.description ? `Description: ${detail.description}` : '',
        truncated
          ? `\nWARNING: this document is ${rawHtml.length} characters and has been TRUNCATED to the first ${MAX_INSIGHT_READ_CHARS}. Do NOT submit an edit built from this fragment — it would silently drop the rest. Tell the user the document is too large to edit wholesale.`
          : '',
        '\nCurrent document:\n',
        html,
      ]
        .filter(Boolean)
        .join('\n');
    } catch {
      return `Insight "${resolvedId}" not found in this workspace.`;
    }
  },
  {
    name: 'get_insight',
    description: `Read an insight's current HTML document (or the unpublished draft in a scheduled refresh run).

Read before editing — propose_insight_edit in chat, edit_insight_section or replace_insight_document in the workforce. Reading first lets you see the current document in order to change parts of it without dropping the rest. In chat, an insight too large to rewrite in one turn comes back as an outline with an instruction to hand the edit to the Workforce — follow it. Defaults to the insight open in page context, or the target insight in a scheduled refresh run.`,
    schema: z.object({
      insight_id: z
        .string()
        .optional()
        .describe(
          'Insight UUID. Omit to read the insight currently open, or the target insight in a scheduled refresh run.',
        ),
    }),
  },
);
