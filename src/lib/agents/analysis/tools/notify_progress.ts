import { tool } from '@langchain/core/tools';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';

/**
 * notify_progress — email the task owner a mid-run progress milestone (MB-90,
 * criterion #5A).
 *
 * The recipient is resolved from the run that owns this agent invocation: the
 * LangGraph `thread_id` (== ai_workforce_queue.id) is read off the runtime
 * config, never passed by the model, so the agent can't redirect the email.
 *
 * Workforce-only. Call sparingly — at meaningful milestones (e.g. every 10–20
 * items, or 25%/50% through a list), not every turn. Use report_progress for
 * the per-turn live trace block; this tool is for the email digest of progress.
 */
function extractRunId(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.thread_id;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export const notifyProgress = tool(
  async (
    args: { progress: string; headline?: string },
    runtime?: RunnableConfig,
  ) => {
    logger.debug(`🔧 TOOL CALLED: notify_progress(headline='${args.headline ?? ''}')`);

    const runId = extractRunId(runtime);
    if (!runId) {
      return 'No run context is available; progress notification skipped.';
    }
    if (!args.progress?.trim()) {
      return '**Error:** progress is required.';
    }

    try {
      const db = createDb();
      const notifier = new EmailNotificationService({
        workforceRepo: new AiWorkforceQueueRepository(db, await getActiveWorkspaceId()),
        routinesRepo: new RoutinesRepository(db, await getActiveWorkspaceId()),
        userRepo: new UserRepository(db),
        workspaceRepo: new WorkspaceRepository(db),
      });
      const sent = await notifier.notifyTaskProgress(runId, {
        progress: args.progress,
        headline: args.headline,
      });
      return sent
        ? 'Progress update emailed to the task owner.'
        : 'Progress update not sent (notifications disabled or no recipient on file).';
    } catch (error) {
      logger.error(`notify_progress failed: ${(error as Error).message}`);
      return `**Error:** Could not send progress update — ${(error as Error).message}`;
    }
  },
  {
    name: 'notify_progress',
    description: `Email the task owner a progress milestone for the current workforce run. Recipient is resolved from the run — you do NOT pass an email.

Call this at meaningful milestones only (e.g. every 10–20 items processed, or at 25%/50% completion), NOT every turn. For the live per-turn trace block use report_progress instead.

Args:
    progress: Required. One-to-two sentence status, e.g. "47 companies scanned, 12 pass L0, 5 pass L1, continuing...".
    headline: Optional short suffix used in the email subject, e.g. "47 companies scanned". Defaults to "Progress Update".

Returns:
    A short confirmation string, or an error string starting with **Error:**.`,
    schema: z.object({
      progress: z
        .string()
        .min(1)
        .max(600)
        .describe('Short progress status shown in the email body.'),
      headline: z
        .string()
        .max(80)
        .optional()
        .describe('Optional short subject suffix, e.g. "47 companies scanned".'),
    }),
  },
);
