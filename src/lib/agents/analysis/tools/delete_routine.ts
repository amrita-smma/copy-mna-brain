import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { BotForbiddenError, BotNotFoundError } from '@/lib/services/botService';
import { BotRoutineNotFoundError } from '@/lib/services/botRoutineService';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { resolveRoutineRef } from './routineRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  routine: z
    .string()
    .min(1)
    .describe('The routine to delete: its id from list_routines, or its title (or a phrase from it that matches one routine).'),
});

/**
 * Delete one of this bot's routines for good, at once. Pausing
 * (update_routine with enabled false) is the usual way to stop one; this is
 * for a routine the user wants gone. Withheld from background turns: a
 * routine's own run, or another bot's message, must not delete routines with
 * nobody watching.
 */
export const deleteRoutine = tool(
  async (args: z.infer<typeof argsSchema>, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: delete_routine(routine='${args.routine}')`);
    const ctx = readBotToolContext(config);
    if (!ctx?.botId) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botRoutineService } = createContainer(createDb(), await getActiveWorkspaceId());
      const routines = await botRoutineService.list(ctx.userId, ctx.botId);
      const target = resolveRoutineRef(routines, args.routine);
      if (!target) {
        return `Rejection: no single routine matches "${args.routine}". Call list_routines and name one by its id or exact title.`;
      }
      await botRoutineService.archive(ctx.userId, ctx.botId, target.id);
      const lines = [`Deleted the routine "${target.title}" (${target.schedule_label}, id ${target.id}).`];
      if (!target.is_mine) {
        lines.push(`It was created by ${target.created_by_name ?? 'someone else'}; it no longer runs for them either.`);
      }
      return lines.join('\n');
    } catch (error) {
      if (error instanceof BotRoutineNotFoundError) return `Rejection: the routine "${args.routine}" is already gone.`;
      if (error instanceof BotForbiddenError || error instanceof BotNotFoundError) {
        return "Rejection: the user cannot change this bot's routines.";
      }
      logger.error(`delete_routine error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'delete_routine',
    description:
      "Delete one of this bot's routines for good, at once — no approval card. Prefer update_routine with enabled false when the user only wants it to stop for a while; delete when they want it gone. Name it by id from list_routines or by its title; an ambiguous phrase is refused.",
    schema: argsSchema,
  },
);
