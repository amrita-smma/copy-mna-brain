import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { UserTaskValidationError } from '@/lib/services/userTaskService';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { describeTask } from './taskRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  title: z.string().min(1).max(500).describe('The task, as one line in the user\'s words ("Call Budi about the SPA").'),
  remind_at: z
    .string()
    .optional()
    .describe(
      'When to remind the user: an ISO 8601 timestamp with a UTC offset (e.g. 2026-10-22T09:00:00+07:00). Work it out from the current time list_tasks reports and the user\'s own time zone; omit for no reminder.',
    ),
});

/**
 * Add a task to the chatting user's personal to-do list, at once: no card,
 * no Workforce. A reminder reaches them in the app and by email when it passes.
 */
export const createTask = tool(
  async (args: z.infer<typeof argsSchema>, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: create_task(title='${args.title}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { userTaskService } = createContainer(createDb(), await getActiveWorkspaceId());
      const task = await userTaskService.create(ctx.userId, { title: args.title, remindAt: args.remind_at ?? null });
      return `Added to the user's tasks: ${describeTask(task, new Date())}.${task.remindAt ? ' They will be reminded in the app and by email when it is due.' : ''}`;
    } catch (error) {
      if (error instanceof UserTaskValidationError) return `Rejection: ${error.message}`;
      logger.error(`create_task error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'create_task',
    description:
      "Add a task to the user's personal to-do list, with an optional reminder time. It is written at once — no approval card, and never a Workforce hand-off: a to-do is the user's own note, not a job. Use it when the user asks you to add, note or remind them of something to do; say in a few words what you added.",
    schema: argsSchema,
  },
);
