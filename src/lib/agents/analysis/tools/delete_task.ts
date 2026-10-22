import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { resolveTaskRef } from './taskRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  task: z.string().min(1).describe('The task to delete: its id from list_tasks, or its title (or a phrase from it that matches one task).'),
});

/**
 * Delete one of the chatting user's tasks for good, at once. Completing a
 * task (update_task) is the usual way to clear it; this is for a task the
 * user wants gone.
 */
export const deleteTask = tool(
  async (args: z.infer<typeof argsSchema>, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: delete_task(task='${args.task}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { userTaskService } = createContainer(createDb(), await getActiveWorkspaceId());
      const tasks = await userTaskService.list(ctx.userId);
      const target = resolveTaskRef(tasks, args.task);
      if (!target) {
        return `Rejection: no single task matches "${args.task}". Call list_tasks and name one by its id or exact title.`;
      }
      const deleted = await userTaskService.delete(ctx.userId, target.id);
      return deleted
        ? `Deleted the task "${target.title}" (id ${target.id}).`
        : `Rejection: the task "${target.title}" is already gone.`;
    } catch (error) {
      logger.error(`delete_task error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'delete_task',
    description:
      "Delete one of the user's tasks for good, at once — no approval card. Prefer update_task with completed true when the user has done the task; delete only when they want it gone. Name it by id from list_tasks or by its title; an ambiguous phrase is refused.",
    schema: argsSchema,
  },
);
