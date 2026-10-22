import { createContainer } from '@/lib/services/container';
import type { DbClient } from '@/lib/repositories';
import { summarizeBotTask } from '@/lib/bots/taskSummary';
import type { BotTaskEntry } from '@/lib/services/botTaskLogService';

/** One Haiku call and one insert. */
export const BOT_TASK_SUMMARY_TIMEOUT_SECONDS = 60;

/**
 * The `bot_task_summary` job: summarize a finished bot turn into one line and
 * add it to the bot's task log. Small talk summarizes to nothing and is not
 * logged.
 */
export async function runBotTaskSummary(
  deps: { db: DbClient; workspaceId: string; entry: BotTaskEntry },
  summarize: typeof summarizeBotTask = summarizeBotTask,
): Promise<{ logged: boolean }> {
  const { entry } = deps;
  const summary = await summarize({
    question: entry.question,
    answer: entry.answer,
    toolNames: entry.toolNames,
    routineTitle: entry.routine?.title ?? null,
  });
  if (!summary) return { logged: false };
  await createContainer(deps.db, deps.workspaceId).botTaskLogService.store(entry, summary);
  return { logged: true };
}
