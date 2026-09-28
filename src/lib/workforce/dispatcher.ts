import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { NO_ACTIVE_WORKSPACE_ID } from '@/lib/constants';
import type { DbClient } from '@/lib/repositories';
import { failAiOpinionIfStillProcessing } from './clearAiOpinionOnFailure';
import { triggerWorkflowForRun } from './workflowTrigger';

export type DispatchResult =
  | { outcome: 'lock_contended' }
  | { outcome: 'running_already' }
  | { outcome: 'empty' }
  | { outcome: 'claimed'; runId: string };

/**
 * The dispatcher critical section. Called from:
 *   - reactive fire-and-forget after enqueueAgentRun, resolveMutation, subagent finalize
 *   - the cron route (every minute) as the safety net
 *
 * The atomic claim is serialized via pg_try_advisory_xact_lock in the repo;
 * concurrent callers either claim the same row's status predicate fight or
 * the lock-loser exits cleanly. Both paths return outcome='lock_contended'
 * or outcome='empty' — both benign.
 */
export async function dispatcherTick(db: DbClient): Promise<DispatchResult> {
  // NO_ACTIVE_WORKSPACE_ID is a placeholder, not a scope: the constructor
  // requires a workspaceId, but hasRunning/claimNextRunnable are the MB-147
  // queue-mechanics surface, which is deliberately workspace-agnostic (one
  // shared worker queue across every workspace — see the repo's constructor
  // doc comment). This tick never touches the workspace-scoped CRUD surface.
  const queueRepo = new AiWorkforceQueueRepository(db, NO_ACTIVE_WORKSPACE_ID);

  // Clear wedged rows BEFORE the hasRunning precheck. Vercel crons are
  // production-only, so /api/cron/dispatch — reapStuckRuns' only other caller —
  // never fires on preview; without this a crashed run blocks the shared queue
  // for every workspace indefinitely. The precheck below would also short-
  // circuit on the very row we need to clear, so the order here matters.
  try {
    await reapStuckRuns(db);
  } catch (err) {
    console.error('[dispatcher] reap failed; continuing to dispatch:', err);
  }

  // Fast precheck without acquiring the lock — avoids txn churn on the common
  // case where nothing is runnable. The advisory lock inside claimNextRunnable
  // is the source of truth; this is just a cheap fast-fail.
  if (await queueRepo.hasRunning()) {
    return { outcome: 'running_already' };
  }

  const claimed = await queueRepo.claimNextRunnable();
  if (!claimed) {
    // Could be lock contention, could be empty queue, could be race-lost.
    // We don't distinguish here — caller doesn't care.
    return { outcome: 'empty' };
  }

  await triggerWorkflowForRun(claimed.id);
  return { outcome: 'claimed', runId: claimed.id };
}

// Workforce runs execute as durable Vercel Workflows rather than rows in the
// `jobs` table, so their "timeout" is how long a claimed run may go without a
// heartbeat before the reaper marks it failed. Set to 30 minutes to give
// long agent loops room to run (vs. the 8-minute budget for regular jobs).
export const DEFAULT_REAPER_STALENESS_SECONDS = 30 * 60; // 30 minutes

export interface ReapResult {
  reaped: string[];
  scanned: number;
}

/**
 * Find runs stuck in 'running' with stale heartbeats and mark them failed.
 *
 * In Tier 2 the workflow heartbeats once and finishes within seconds for the
 * happy path, so the reaper only catches genuinely-stuck runs (workflow
 * crashed after claim but before finalize, start() failed silently, runtime
 * down). Tier 3's longer agent loops will periodically heartbeat to keep
 * legitimate long runs alive while still detecting actual crashes.
 */
export async function reapStuckRuns(
  db: DbClient,
  options: { stalenessSeconds?: number; now?: () => Date } = {},
): Promise<ReapResult> {
  const stalenessSeconds =
    options.stalenessSeconds ?? DEFAULT_REAPER_STALENESS_SECONDS;
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - stalenessSeconds * 1000).toISOString();

  // Same placeholder as dispatcherTick — findStuckRunning is workspace-agnostic.
  const queueRepo = new AiWorkforceQueueRepository(db, NO_ACTIVE_WORKSPACE_ID);
  const stuck = await queueRepo.findStuckRunning(cutoff);

  const reaped: string[] = [];
  for (const row of stuck) {
    try {
      await queueRepo.markFailed(row.id, {
        code: 'stuck_no_heartbeat',
        message: `last_heartbeat_at older than ${stalenessSeconds}s`,
        last_heartbeat_at: row.last_heartbeat_at,
      });
      await failAiOpinionIfStillProcessing(
        db,
        row.workspace_id,
        row.trigger_meta,
        row.agent_name,
      );
      reaped.push(row.id);
    } catch (err) {
      console.error(`[reaper] failed to mark ${row.id} as failed:`, err);
    }
  }

  return { reaped, scanned: stuck.length };
}
