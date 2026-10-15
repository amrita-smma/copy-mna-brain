import { AutoScanQueueRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';

/**
 * Companies claimed per drain. Each runs as its own `pending_auto_scan` job in
 * the draining invocation, screening all of its criteria in parallel, so this
 * bounds concurrent agent calls per minute.
 */
export const PENDING_AUTO_SCAN_BATCH_SIZE = 3;

export interface PendingAutoScanDrainResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

/**
 * One tick of the Pending Confirmation auto-scan queue (every workspace):
 * claim the oldest requests and start a background job for each, in its own
 * workspace's container. Called by `/api/cron/pending-auto-scan`.
 */
export async function drainPendingAutoScanQueue(
  db: DbClient,
  limit: number = PENDING_AUTO_SCAN_BATCH_SIZE,
): Promise<PendingAutoScanDrainResult> {
  const claimed = await new AutoScanQueueRepository(db).claim(limit);
  if (claimed.length === 0) return { claimed: 0, dispatched: 0, failed: 0 };

  // Imported lazily: the container reaches the job handler, which imports the
  // container lazily too — keep this module light for the cron route.
  const { createContainer } = await import('@/lib/services/container');
  let dispatched = 0;
  let failed = 0;
  for (const item of claimed) {
    try {
      const { pendingAutoScanService } = createContainer(db, item.workspaceId);
      await pendingAutoScanService.dispatchScan(item.companyId, item.force);
      dispatched++;
    } catch (err) {
      failed++;
      console.error(`[pendingAutoScan] failed to dispatch scan for ${item.companyId}:`, err);
      // Claim cleared the queue mark — put it back so the next drain retries.
      try {
        const { pendingAutoScanService } = createContainer(db, item.workspaceId);
        await pendingAutoScanService.requeueScan(item.companyId, item.force);
      } catch (requeueErr) {
        console.error(`[pendingAutoScan] failed to re-queue ${item.companyId}:`, requeueErr);
      }
    }
  }
  return { claimed: claimed.length, dispatched, failed };
}
