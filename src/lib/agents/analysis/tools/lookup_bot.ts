import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import type { BotDto } from '@/lib/bots/types';
import { personaText } from '@/lib/bots/persona';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { logger } from '../../logger';

/** How much of a bot's persona the lookup shows as "what it does". */
export const LOOKUP_PERSONA_CHARS = 280;

/** The persona as one line, clipped: what the bot does, as its owner put it. */
function whatItDoes(bot: BotDto): string {
  const text = personaText(bot.persona_md).replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Not set up yet (blank persona)';
  return text.length > LOOKUP_PERSONA_CHARS ? `${text.slice(0, LOOKUP_PERSONA_CHARS - 1)}…` : text;
}

/** Query words found in the bot's name and persona: a cheap relevance score. */
function relevance(bot: BotDto, words: string[]): number {
  if (words.length === 0) return 0;
  const hay = `${bot.name} ${personaText(bot.persona_md)}`.toLowerCase();
  return words.filter((w) => hay.includes(w)).length;
}

/**
 * The bots the signed-in user can see, with what each does (its persona),
 * best matches for `query` first. Every bot calls it before handing work to
 * another bot, so it picks the right one, and before changing one.
 */
export const lookupBot = tool(
  async (args: { query?: string }, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: lookup_bot(query='${args.query ?? ''}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botService } = createContainer(createDb(), await getActiveWorkspaceId());
      const bots = await botService.list(ctx.userId);
      const words = (args.query ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2);
      const ranked = bots
        .map((bot, i) => ({ bot, i, score: relevance(bot, words) }))
        .sort((a, b) => b.score - a.score || a.i - b.i);
      let out = `**Bots (${bots.length})**${words.length > 0 ? ', best matches first' : ''}:\n\n| Name | Id | What it does | Shared | You can edit |\n| --- | --- | --- | --- | --- |\n`;
      for (const { bot: b } of ranked) {
        const me = b.id === ctx.botId ? ' (you)' : '';
        out += `| ${b.name}${me}${b.is_default ? ' · primary' : ''} | ${b.id} | ${whatItDoes(b)} | ${b.visibility === 'workspace' && !b.is_default ? 'yes' : 'no'} | ${b.can_edit ? 'yes' : 'no'} |\n`;
      }
      return out;
    } catch (error) {
      logger.error(`lookup_bot error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'lookup_bot',
    description:
      "Look up the user's Copilot bots: each one's name, id, what it does (its persona), whether it is shared, and whether the user may edit it. Pass `query` — what the work is about — to rank the bots that fit first. Call it before every hand-off to another bot (an @mention), to pick the right bot, and before changing a bot, to use its exact name.",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe('What the work is about, e.g. "coal mining deals in Indonesia"; ranks the best-fitting bots first.'),
    }),
  },
);
