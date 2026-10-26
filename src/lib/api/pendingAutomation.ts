import { apiRequest } from '@/lib/api/client';
import type {
  PendingAutomation,
  ScanNowPreview,
  ScanNowSelection,
} from '@/lib/sourcing/pendingAutomation';

/** The active workspace's Pending Confirmation automation toggles. */
export function getPendingAutomation(): Promise<PendingAutomation> {
  return apiRequest<PendingAutomation>('/api/pending-automation');
}

/**
 * Save all three toggles. Auto-scan applies to companies arriving from now on;
 * it does not queue the ones already waiting.
 */
export function savePendingAutomation(input: PendingAutomation): Promise<PendingAutomation> {
  return apiRequest<PendingAutomation>('/api/pending-automation', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * Scan now: queue an AI Workforce screening task for every active Pending
 * Confirmation company — or, with a `selection`, only those matched to the
 * selected tracks. `alreadyQueued` counts ones skipped as already in flight.
 */
export function scanPendingNow(
  selection?: ScanNowSelection,
): Promise<{ queued: number; alreadyQueued: number }> {
  return apiRequest<{ queued: number; alreadyQueued: number }>('/api/pending-automation/scan', {
    method: 'POST',
    ...(selection ? { body: JSON.stringify(selection) } : {}),
  });
}

/**
 * Every Pending Confirmation company with its saved tracks, whether it has a
 * Company Card and whether it is already queued. Feeds the confirmation
 * dialog's track selector and estimate.
 */
export function getScanNowPreview(): Promise<ScanNowPreview> {
  return apiRequest<ScanNowPreview>('/api/pending-automation/scan');
}
