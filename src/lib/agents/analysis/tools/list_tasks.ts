import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { formatTaskList } from './taskRef';
import { logger } from '../../logger';

const argsSchema = z.object({
  include_completed: z.boolean().optional().describe('Also list the recently completed tasks (default: open tasks only).'),
});

/**
 * The chatting user's personal to-do list (`/tasks`): open tasks with their
 * reminders, overdue ones flagged, and the current time so a relative
 * reminder ("tomorrow at 9") can be worked out. Read it before changing a
 * task, so the change lands on the right one.
 */
export const listTasks = tool(
  async (args: z.infer<typeof argsSchema>, config?: RunnableConfig) => {
    logger.debug('🔧 TOOL CALLED: list_tasks()');
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { userTaskService } = createContainer(createDb(), await getActiveWorkspaceId());
      const tasks = await userTaskService.list(ctx.userId);
      return formatTaskList(tasks, new Date(), args.include_completed === true);
    } catch (error) {
      logger.error(`list_tasks error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'list_tasks',
    description:
      "The user's personal to-do list: their open tasks with reminders (overdue ones flagged) and the current time, plus the recently completed ones on request. Read it before updating or deleting a task so you name the right one. These are the user's own tasks, seen by nobody else.",
    schema: argsSchema,
  },
);
