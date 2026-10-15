import type { DbClient, Tables } from '@/lib/repositories';
import type { PendingAutoScanResult } from '@/lib/services/pendingAutoScanService';

/**
 * Track matching (~1 min) plus every criterion screened in parallel (each up
 * to `AI_SCREENING_TIMEOUT_SECONDS`, 480s), with headroom — and under the
 * draining cron route's `maxDuration`.
 */
export const PENDING_AUTO_SCAN_TIMEOUT_SECONDS = 570;

export interface PendingAutoScanPayload {
  companyId: string;
  /** Re-screen criteria that already have a result (the Scan now button). */
  force: boolean;
  workspaceId: string;
}

/**
 * One Pending Confirmation company's auto-scan, queued as a
 * `pending_auto_scan` job by the `/api/cron/pending-auto-scan` drain.
 */
export async function runPendingAutoScan(
  payload: PendingAutoScanPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<PendingAutoScanResult> {
  if (!payload?.companyId) throw new Error('pending_auto_scan: `companyId` is required');
  if (!payload.workspaceId) throw new Error('pending_auto_scan: `workspaceId` is required');

  // Imported lazily: the container reaches PendingAutoScanService, which
  // dispatches this job — a static import would close that cycle.
  const { createContainer } = await import('@/lib/services/container');
  const { pendingAutoScanService } = createContainer(deps.db, payload.workspaceId);
  return pendingAutoScanService.processCompany(payload.companyId, {
    force: payload.force === true,
    jobId: deps.job.id,
  });
}
