import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { UserTaskValidationError } from '@/lib/services/userTaskService';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { describeTask, resolveTaskRef } from './taskRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  task: z.string().min(1).describe('The task to change: its id from list_tasks, or its title (or a phrase from it that matches one task).'),
  title: z.string().min(1).max(500).optional().describe('A new title.'),
  remind_at: z
    .string()
    .nullable()
    .optional()
    .describe('A new reminder time (ISO 8601 with a UTC offset), or null to remove the reminder.'),
  completed: z.boolean().optional().describe('true to mark it done, false to reopen it.'),
});

/**
 * Change one of the chatting user's tasks — rename it, move or clear its
 * reminder, mark it done or reopen it — at once, no card. The task is named
 * by id or title; a phrase matching several tasks is refused rather than
 * guessed.
 */
export const updateTask = tool(
  async (args: z.infer<typeof argsSchema>, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: update_task(task='${args.task}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    if (args.title === undefined && args.remind_at === undefined && args.completed === undefined) {
      return 'Rejection: pass a new title, a remind_at (or null to clear it), or completed.';
    }
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { userTaskService } = createContainer(createDb(), await getActiveWorkspaceId());
      const tasks = await userTaskService.list(ctx.userId);
      const target = resolveTaskRef(tasks, args.task);
      if (!target) {
        return `Rejection: no single task matches "${args.task}". Call list_tasks and name one by its id or exact title.`;
      }
      const updated = await userTaskService.update(ctx.userId, target.id, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.remind_at !== undefined ? { remindAt: args.remind_at } : {}),
        ...(args.completed !== undefined ? { completed: args.completed } : {}),
      });
      if (!updated) return `Rejection: the task "${target.title}" is gone (deleted meanwhile).`;
      const what =
        args.completed === true
          ? 'Marked done'
          : args.completed === false
            ? 'Reopened'
            : 'Updated';
      return `${what}: ${describeTask(updated, new Date())}.`;
    } catch (error) {
      if (error instanceof UserTaskValidationError) return `Rejection: ${error.message}`;
      logger.error(`update_task error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'update_task',
    description:
      "Change one of the user's tasks: rename it, set, move or clear its reminder (remind_at null), mark it done (completed true) or reopen it. Written at once — no approval card. Name the task by its id from list_tasks or by its title; if a phrase could mean several tasks, the tool refuses and you should ask.",
    schema: argsSchema,
  },
);
