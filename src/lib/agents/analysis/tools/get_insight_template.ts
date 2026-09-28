import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import type { InsightTemplate } from '@/lib/repositories';
import { isUuid } from '@/lib/uuid';
import { fuzzySearch, matchLabel } from './fuzzySearch';

function listing(templates: InsightTemplate[]): string {
  if (templates.length === 0) return 'This workspace has no insight templates.';
  return [
    'Available insight templates:',
    ...templates.map(
      (t) => `- ${t.name} (id ${t.id})${t.description ? ` — ${t.description}` : ''}`,
    ),
  ].join('\n');
}

/** True in an AI Workforce run (runAgent sets `agentRole: 'workforce'`); chat and anything else read as chat. */
function isWorkforceRun(runtime?: RunnableConfig): boolean {
  return runtime?.configurable?.agentRole === 'workforce';
}

/**
 * A template the user attaches in the composer arrives already expanded in
 * their message as an `<insight_template>` block, so this tool is for the
 * other cases: a template named in plain text, a template_id carried into a
 * later turn, and Workforce runs whose handoff instruction names one.
 *
 * In a Workforce run it returns the template's full HTML in consecutive parts
 * (`part`, 1-based). In chat it returns the same block an attachment gets: the
 * full HTML for a template chat can build, or an outline plus the Workforce
 * handoff rule for one too large to build in chat.
 */
export const getInsightTemplate = tool(
  async (
    { template_id, template_name, part }: { template_id?: string; template_name?: string; part?: number },
    runtime?: RunnableConfig,
  ) => {
    logger.debug('🔧 TOOL CALLED: get_insight_template()');

    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    let templates: InsightTemplate[];
    try {
      templates = await insightTemplateService.list();
    } catch (error) {
      logger.error(`get_insight_template list error: ${(error as Error).message}`);
      return `**Error:** could not load insight templates: ${(error as Error).message}`;
    }

    const requestedId = template_id?.trim();
    // isUuid, not zod .uuid(): seeded template ids aren't RFC-versioned.
    let resolved =
      requestedId && isUuid(requestedId) ? templates.find((t) => t.id === requestedId) : undefined;
    const badIdNote =
      requestedId && !resolved
        ? `Note: template_id "${requestedId}" does not match any template in this workspace.\n`
        : '';

    if (!resolved) {
      const query = template_name?.trim();
      if (!query) {
        return `${badIdNote}No insight template was specified. Pass template_name or template_id, or ask the user which template to use.\n\n${listing(templates)}`;
      }

      const hits = fuzzySearch(query, templates, (t) => [t.name], { limit: 5 });
      if (hits.length === 0) {
        return `${badIdNote}No insight template matches "${query}".\n\n${listing(templates)}`;
      }

      const [best, runnerUp] = hits;
      const clearWinner =
        hits.length === 1 || best.score >= 0.999 || best.score - runnerUp.score >= 0.15;
      if (!clearWinner) {
        return [
          `${badIdNote}Several insight templates match "${query}":`,
          ...hits.map(
            ({ item, score }) => `- ${item.name} (id ${item.id}, ${matchLabel(score)} match)`,
          ),
          '',
          'If one is clearly what the user meant, call get_insight_template again with its template_id. Otherwise ask the user which one they mean.',
        ].join('\n');
      }
      resolved = best.item;
    }

    logger.debug(`get_insight_template resolved ${resolved.id}`);
    const attachment = { id: resolved.id, name: resolved.name };
    const block = isWorkforceRun(runtime)
      ? await insightTemplateService.readPartForWorkforce(attachment, part ?? 1)
      : await insightTemplateService.prepareForMessage(attachment);
    return `${badIdNote}${block.text}`;
  },
  {
    name: 'get_insight_template',
    description: `Read an insight template: its name, id and HTML.

A template the user attached to their message is ALREADY in that message as an
<insight_template> block — do not call this for it. Call this when the user names
a template in plain text, or when you have a template_id from an earlier turn or
a handoff instruction. Build the new insight on the returned HTML.

In an AI Workforce run the HTML comes in parts: the header says "part i of n";
call again with part i+1 until you have read part n, and read every part before
building. In chat, a template too large to build in chat comes back as an
outline with an instruction to hand the work to the Workforce — follow it.`,
    schema: z.object({
      template_id: z
        .string()
        .optional()
        .describe('Template id from an <insight_template> block, an earlier result, or a handoff instruction.'),
      template_name: z
        .string()
        .optional()
        .describe('Template name to look up when no id is known. Fuzzy-matched.'),
      part: z
        .number()
        .int()
        .optional()
        .describe('Workforce runs only: which part of the template HTML to read, 1-based. Defaults to 1.'),
    }),
  },
);
