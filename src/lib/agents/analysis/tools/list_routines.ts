import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { BotForbiddenError, BotNotFoundError } from '@/lib/services/botService';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { logger } from '../../logger';

/**
 * This bot's routines: the scheduled messages it gets on someone's behalf.
 * What the bot reads before proposing a new one, so it does not duplicate one,
 * and where it gets the id update_routine and delete_routine take.
 */
export const listRoutines = tool(
  async (_args: Record<string, never>, config?: RunnableConfig) => {
    logger.debug('🔧 TOOL CALLED: list_routines()');
    const ctx = readBotToolContext(config);
    if (!ctx?.botId) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botRoutineService } = createContainer(createDb(), await getActiveWorkspaceId());
      const routines = await botRoutineService.list(ctx.userId, ctx.botId);
      if (routines.length === 0) return 'You have no routines yet.';
      let out = `**Your routines (${routines.length}):**\n\n| Id | Title | Schedule | On | Next run | Last run | Created | Created by | Message |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const r of routines) {
        const who = r.is_mine ? 'the user' : (r.created_by_name ?? 'someone else');
        const message = r.prompt.replace(/\s+/g, ' ').slice(0, 120);
        out += `| ${r.id} | ${r.title} | ${r.schedule_label} | ${r.enabled ? 'yes' : 'paused'} | ${r.next_fire_at ?? '—'} | ${r.last_fired_at ?? 'never'} | ${r.created_at} | ${who} | ${message} |\n`;
      }
      return out;
    } catch (error) {
      if (error instanceof BotForbiddenError || error instanceof BotNotFoundError) {
        return "Rejection: the user cannot see this bot's routines.";
      }
      logger.error(`list_routines error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'list_routines',
    description:
      "List this bot's routines: each scheduled message's id, title, schedule, whether it is on, its next and last run, when and by whom it was created, and the message it sends. Check it before proposing a routine so you do not duplicate one, and to get the id update_routine and delete_routine take.",
    schema: z.object({}),
  },
);
