import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { BotForbiddenError, BotNotFoundError } from '@/lib/services/botService';
import { BotRoutineNotFoundError, BotRoutineValidationError } from '@/lib/services/botRoutineService';
import type { BotRoutinePatch } from '@/lib/bots/routineTypes';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { routineArgs } from './routineArgs';
import { describeRoutine, hasScheduleChange, resolveRoutineRef, schedulePatch } from './routineRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  routine: z
    .string()
    .min(1)
    .describe('The routine to change: its id from list_routines, or its title (or a phrase from it that matches one routine).'),
  title: routineArgs.title.optional(),
  message: routineArgs.message.optional(),
  enabled: z.boolean().optional().describe('false to pause the routine, true to resume it (a resumed routine counts from now).'),
  schedule: routineArgs.schedule
    .optional()
    .describe('A new schedule kind; leave out to keep the current one and change only its details (a cron expression alone switches to cron).'),
  time: routineArgs.time,
  weekdays: routineArgs.weekdays,
  day_of_month: routineArgs.day_of_month,
  cron: routineArgs.cron,
  timezone: routineArgs.timezone.describe('IANA timezone the time is in, e.g. "Asia/Jakarta". Leave out to keep the routine\'s current timezone.'),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Change one of this bot's routines — its title, its message, when it runs,
 * or pause / resume it — at once, no card. The routine is named by id or
 * title; a phrase matching several routines is refused rather than guessed.
 * Schedule details given are laid over the routine's own, so "move it to
 * 10:00" keeps its weekdays. Permission is the routines service's: whoever
 * may edit the bot (their own routines only on Brain Bot).
 */
export const updateRoutine = tool(
  async (args: Args, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: update_routine(routine='${args.routine}')`);
    const ctx = readBotToolContext(config);
    if (!ctx?.botId) return NO_USER_CONTEXT_ERROR;
    if (args.title === undefined && args.message === undefined && args.enabled === undefined && !hasScheduleChange(args)) {
      return 'Rejection: pass a new title, message, enabled, or a schedule change (schedule, time, weekdays, day_of_month, cron or timezone).';
    }
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botRoutineService } = createContainer(createDb(), await getActiveWorkspaceId());
      const routines = await botRoutineService.list(ctx.userId, ctx.botId);
      const target = resolveRoutineRef(routines, args.routine);
      if (!target) {
        return `Rejection: no single routine matches "${args.routine}". Call list_routines and name one by its id or exact title.`;
      }
      const patch: BotRoutinePatch = {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.message !== undefined ? { prompt: args.message } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(hasScheduleChange(args) ? schedulePatch(target, args) : {}),
      };
      const updated = await botRoutineService.update(ctx.userId, ctx.botId, target.id, patch);
      const what = args.enabled === false ? 'Paused' : args.enabled === true && !target.enabled ? 'Resumed' : 'Updated';
      const lines = [`${what}: ${describeRoutine(updated)}.`];
      if (!target.is_mine) {
        lines.push(
          `This routine was created by ${target.created_by_name ?? 'someone else'} and keeps running as them; everyone who uses this bot sees the change.`,
        );
      }
      return lines.join('\n');
    } catch (error) {
      if (error instanceof BotRoutineValidationError) return `Rejection: ${error.message}`;
      if (error instanceof BotRoutineNotFoundError) return `Rejection: the routine "${args.routine}" is gone (deleted meanwhile).`;
      if (error instanceof BotForbiddenError || error instanceof BotNotFoundError) {
        return "Rejection: the user cannot change this bot's routines.";
      }
      logger.error(`update_routine error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'update_routine',
    description:
      "Change one of this bot's routines at once — no approval card: rename it, rewrite the message it sends you, move it to another time, day or timezone, change its schedule kind, or pause (enabled false) / resume (enabled true) it. Give only the fields that change; schedule details you leave out stay as they are. Name the routine by its id from list_routines or by its title; if a phrase could mean several routines, the tool refuses and you should ask.",
    schema: argsSchema,
  },
);
