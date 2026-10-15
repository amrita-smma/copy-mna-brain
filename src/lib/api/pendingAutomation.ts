import { apiRequest } from '@/lib/api/client';
import type { PendingAutomation } from '@/lib/sourcing/pendingAutomation';

/** The active workspace's Pending Confirmation automation toggles. */
export function getPendingAutomation(): Promise<PendingAutomation> {
  return apiRequest<PendingAutomation>('/api/pending-automation');
}

/**
 * Save both toggles. Auto-scan applies to companies arriving from now on; it
 * does not queue the ones already waiting.
 */
export function savePendingAutomation(input: PendingAutomation): Promise<PendingAutomation> {
  return apiRequest<PendingAutomation>('/api/pending-automation', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Scan now: queue every active Pending Confirmation company for a fresh scan. */
export function scanPendingNow(): Promise<{ queued: number }> {
  return apiRequest<{ queued: number }>('/api/pending-automation/scan', { method: 'POST' });
}
