/**
 * The dispatch cron's backfill of chat-history vectors: stored exchanges
 * whose embedding job never ran or failed stay findable by full text only,
 * which misses most natural-language questions (`search_chat_history`'s
 * lexical leg ANDs every term). This queues an embedding job for a batch of
 * them, per workspace, each tick, until none are left.
 */
import type { DbClient } from '@/lib/repositories';
import { findUnembeddedChatMessages } from '@/lib/repositories';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';

/** Rows queued per tick, across workspaces; a job embeds one row per Bedrock call. */
export const EMBEDDING_SWEEP_BATCH = 40;

export async function sweepUnembeddedChatMessages(
  db: DbClient,
  limit = EMBEDDING_SWEEP_BATCH,
): Promise<{ queued: number; workspaces: number }> {
  const rows = await findUnembeddedChatMessages(db, limit);
  const byWorkspace = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byWorkspace.get(row.workspace_id) ?? [];
    ids.push(row.id);
    byWorkspace.set(row.workspace_id, ids);
  }
  let queued = 0;
  for (const [workspaceId, ids] of byWorkspace) {
    try {
      // Lazy, like the other sweeps: the container pulls in the agent runtime.
      const { createContainer } = await import('@/lib/services/container');
      queued += await runWithWorkforceWorkspaceId(workspaceId, () =>
        createContainer(db, workspaceId).chatHistoryService.queueEmbeddings(ids),
      );
    } catch (err) {
      console.error(`[chat-history] embedding sweep failed for workspace ${workspaceId}:`, err);
    }
  }
  return { queued, workspaces: byWorkspace.size };
}
