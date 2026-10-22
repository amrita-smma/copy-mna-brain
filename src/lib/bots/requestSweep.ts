/**
 * The dispatch cron's sweep of bot requests nobody closed: a bot asked
 * another bot something (an @mention), the answering job was lost — its
 * `after()` cut off, the instance gone — and the asker would wait forever.
 * Each stale request is timed out through its workspace's
 * `BotRequestService`, which still sends the asker its reply turn.
 */
import type { DbClient } from '@/lib/repositories';
import { findStaleBotRequests } from '@/lib/repositories';
import { BOT_REQUEST_SWEEP_BATCH, BOT_REQUEST_TIMEOUT_SECONDS } from '@/lib/services/botRequestService';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';

export async function sweepBotRequests(db: DbClient): Promise<{ timedOut: number; workspaces: number }> {
  const stale = await findStaleBotRequests(db, BOT_REQUEST_TIMEOUT_SECONDS, BOT_REQUEST_SWEEP_BATCH);
  const workspaces = [...new Set(stale.map((r) => r.workspace_id))];
  let timedOut = 0;
  for (const workspaceId of workspaces) {
    try {
      // Lazy, like the routines sweep: the container pulls in the agent runtime.
      const { createContainer } = await import('@/lib/services/container');
      timedOut += await runWithWorkforceWorkspaceId(workspaceId, () =>
        createContainer(db, workspaceId).botRequestService.sweep(BOT_REQUEST_TIMEOUT_SECONDS),
      );
    } catch (err) {
      console.error(`[bot-requests] sweep failed for workspace ${workspaceId}:`, err);
    }
  }
  return { timedOut, workspaces: workspaces.length };
}
