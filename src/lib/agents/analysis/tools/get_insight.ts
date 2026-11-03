import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { resolveInsightId, validateSectionKey } from '@/lib/insights/toolValidation';
import { readInsightRunContext } from '@/lib/insights/refreshRun';
import { isTooLargeForChat } from '@/lib/insights/templateAttachment';
import {
  formatLargeInsightForChat,
  formatLargeInsightSectionForChat,
} from '@/lib/insights/largeDocument';
import { extractInsightSection, listInsightSectionKeys } from '@/lib/insights/sectionEdit';

export const MAX_INSIGHT_READ_CHARS = 60000;

/** True in an AI Workforce run (runAgent sets `agentRole: 'workforce'` and a `run_id`); chat reads as chat. */
function isWorkforceRun(runtime: RunnableConfig | undefined, runId: string | null): boolean {
  return runtime?.configurable?.agentRole === 'workforce' || runId !== null;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export const getInsight = tool(
  async ({ insight_id, section }: { insight_id?: string; section?: string }, runtime?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: get_insight(${section ? `section='${section}'` : ''})`);

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

    const wantsSection = section !== undefined && section !== null && section.trim() !== '';
    const sectionKey = wantsSection ? validateSectionKey(section) : null;
    if (sectionKey && 'error' in sectionKey) {
      return sectionKey.error;
    }

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    // Resolved lazily to keep this tool off the container's static import
    // cycle (see TECH_DEBT.md "Runtime import cycle").
    const { createContainer } = await import('@/lib/services/container');
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

      const inChat = !isWorkforceRun(runtime, ctx.runId);
      const header = isDraft
        ? `Insight: ${detail.name} (id ${detail.id}, unpublished draft for this refresh run, based on version ${baseVersionNo})`
        : `Insight: ${detail.name} (id ${detail.id}, version ${detail.version_no})`;
      const headerLines = [
        header,
        detail.kind ? `Kind: ${detail.kind}` : '',
        `Length: ${fmt(rawHtml.length)} characters`,
        detail.description ? `Description: ${detail.description}` : '',
      ].filter(Boolean);

      // ── One section: only that block's bytes reach the model, whatever the
      // size of the document around it. The edit goes back the same way,
      // through propose_insight_edit with the same `section`.
      if (sectionKey && 'key' in sectionKey) {
        const extracted = extractInsightSection(rawHtml, sectionKey.key);
        if (!extracted.success) {
          const keys = listInsightSectionKeys(rawHtml);
          const known =
            keys.length > 0
              ? `The document's data-section keys are: ${keys.map((k) => `"${k}"`).join(', ')}. Call get_insight again with one of them.`
              : inChat && isTooLargeForChat(rawHtml)
                ? 'The document has no data-section keys, so it cannot be read or edited by section — and it is too large to edit whole in chat. Hand the edit to the Workforce with propose_workforce_handoff (it can add data-section keys as it goes).'
                : 'The document has no data-section keys, so it cannot be read or edited by section: read it whole (omit `section`).';
          return [...headerLines, '', `Section "${sectionKey.key}": ${extracted.error}`, known].join('\n');
        }

        if (inChat && isTooLargeForChat(extracted.html)) {
          return [
            ...headerLines,
            '',
            formatLargeInsightSectionForChat({
              id: detail.id,
              section: sectionKey.key,
              html: extracted.html,
            }),
          ].join('\n');
        }

        return [
          ...headerLines,
          `Section: ${sectionKey.key} (${fmt(extracted.html.length)} characters of the ${fmt(rawHtml.length)}-character document)`,
          '',
          inChat
            ? `To change this block, call propose_insight_edit with section: "${sectionKey.key}" and ONLY the block's complete replacement fragment as html — keep data-section="${sectionKey.key}" on its root element. The rest of the document stays exactly as it is. Do not read or resend the whole document for this.`
            : `To change this block, call edit_insight_section with section "${sectionKey.key}" and the block's complete replacement fragment, keeping data-section="${sectionKey.key}" on its root element.`,
          '',
          `Current section:\n`,
          extracted.html,
        ].join('\n');
      }

      // Chat edits a whole document with propose_insight_edit, which carries
      // it in full: one call that size cannot finish inside a chat turn's
      // budget, so chat gets an outline, the invitation to edit one section
      // at a time, and the Workforce for anything wider.
      if (inChat && isTooLargeForChat(rawHtml)) {
        return `${headerLines.join('\n')}\n\n${formatLargeInsightForChat({ id: detail.id, name: detail.name, html: rawHtml })}`;
      }

      const truncated = rawHtml.length > MAX_INSIGHT_READ_CHARS;
      const html = truncated
        ? rawHtml.slice(0, MAX_INSIGHT_READ_CHARS)
        : rawHtml;

      return [
        ...headerLines,
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
    description: `Read an insight's current HTML document (or the unpublished draft in a scheduled refresh run), or just ONE of its data-section blocks.

Read before editing — propose_insight_edit in chat, edit_insight_section or replace_insight_document in the workforce. Reading first lets you see the current document in order to change parts of it without dropping the rest.

Pass \`section\` (a data-section key, from the selection in page context or the insight outline) to read only that block: that is the cheap path for an edit confined to one block, and the only chat path for an insight too large to read whole. Without \`section\`, an insight too large to rewrite in one chat turn comes back as an outline of its section keys with instructions — follow them. Defaults to the insight open in page context, or the target insight in a scheduled refresh run.`,
    schema: z.object({
      insight_id: z
        .string()
        .optional()
        .describe(
          'Insight UUID. Omit to read the insight currently open, or the target insight in a scheduled refresh run.',
        ),
      section: z
        .string()
        .optional()
        .describe(
          'A data-section key (e.g. "market-overview"). Returns only that block\'s HTML instead of the whole document.',
        ),
    }),
  },
);
