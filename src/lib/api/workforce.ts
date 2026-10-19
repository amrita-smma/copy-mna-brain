import { apiRequest } from './client';

/** The Workforce nav item's badges — see `GET /api/workforce-queue/summary`. */
export interface WorkforceNavSummary {
  /** The caller's failed runs they haven't opened since they failed. */
  unseen_failures: number;
  /** Runs waiting to start or resume, plus the ones running. */
  queue: number;
  /** Runs working right now. */
  running: number;
}

export async function getWorkforceNavSummary(): Promise<WorkforceNavSummary> {
  const { data } = await apiRequest<{ data: WorkforceNavSummary }>('/api/workforce-queue/summary');
  return data;
}
