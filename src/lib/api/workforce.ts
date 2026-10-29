import { apiRequest } from './client';

/** The Workforce nav item's badges — see `GET /api/workforce-queue/summary`. */
export interface WorkforceNavSummary {
  /** The workspace's failed / timed-out runs (not cancellations) that finished in the last 24 hours. */
  recent_failures: number;
  /** Runs waiting to start or resume, plus the ones running. */
  queue: number;
  /** Runs working right now. */
  running: number;
}

export function getWorkforceNavSummary(): Promise<WorkforceNavSummary> {
  // `apiRequest` already unwraps the `{ data }` envelope.
  return apiRequest<WorkforceNavSummary>('/api/workforce-queue/summary');
}
