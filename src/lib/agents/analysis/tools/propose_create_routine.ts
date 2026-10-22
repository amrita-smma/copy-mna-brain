import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { BotForbiddenError, BotNotFoundError } from '@/lib/services/botService';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import { BOT_ROUTINE_APPROVAL_MARKER, type BotRoutineApprovalPayload } from '@/lib/bots/approval';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { routineArgsSchema, routineInputFromArgs, type RoutineArgs } from './routineArgs';
import { logger } from '../../logger';

const argsSchema = routineArgsSchema;

type Args = RoutineArgs;

/**
 * Propose a routine for this bot on an approval card: a message the bot is
 * sent on a schedule, as the user. Nothing is scheduled until the user
 * approves; the card then calls the bot routines API, which validates and
 * checks permission again. Withheld from background turns — nobody is there
 * to approve.
 */
export const proposeCreateRoutine = tool(
  async (args: Args, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: propose_create_routine(title='${args.title}')`);
    const ctx = readBotToolContext(config);
    if (!ctx?.botId) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botRoutineService } = createContainer(createDb(), await getActiveWorkspaceId());
      // Validated in UTC when no zone was named; the card sends the
      // browser's zone instead.
      const proposed = routineInputFromArgs(args);
      const { bot, routine, label } = await botRoutineService.preview(ctx.userId, ctx.botId, {
        ...proposed,
        timezone: proposed.timezone || 'UTC',
      });
      // Brain Bot's routines are each user's own, never shared.
      const shared = !bot.is_default && bot.visibility === 'workspace';
      const payload: BotRoutineApprovalPayload = {
        approval_id: randomUUID(),
        bot_id: bot.id,
        bot_name: bot.name,
        shared,
        schedule_label: label,
        input: {
          title: routine.title,
          prompt: routine.prompt,
          schedule_kind: routine.schedule_kind,
          schedule_spec: routine.schedule_spec,
          timezone: args.timezone ?? '',
        },
      };
      const lines = [
        `Proposed the routine **${routine.title}** (${label}) for the user to approve. Nothing is scheduled until they click Schedule on the card.`,
      ];
      if (shared) {
        lines.push(
          'This bot is shared, so everyone in the workspace will see the routine and can change it; it runs as the user who approves it.',
        );
      }
      lines.push('', encodeApprovalMarker(BOT_ROUTINE_APPROVAL_MARKER, payload));
      return lines.join('\n');
    } catch (error) {
      if (error instanceof BotRoutineValidationError) return `Rejection: ${error.message}`;
      if (error instanceof BotForbiddenError || error instanceof BotNotFoundError) {
        return 'Rejection: the user cannot add routines to this bot.';
      }
      logger.error(`propose_create_routine error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'propose_create_routine',
    description:
      'Propose a routine for this bot for the user to approve on a card: a message you are sent on a schedule (daily, weekly, monthly or cron), as the user, in their chat with you, so you do the task and they read the result later. Use it when the user asks for something recurring ("every Monday…", "each morning…"). Nothing is scheduled until the user approves.',
    schema: argsSchema,
  },
);
