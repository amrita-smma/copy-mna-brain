import type { ScreeningTaskStatus } from '@/lib/services/aiScreeningService';

const ACTIVE_AI_SCREENING_TASK_STATUSES = new Set<ScreeningTaskStatus['status']>([
  'pending',
  'resume_ready',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
]);

/** True while the company's AI Workforce screening task is queued or running. */
export function isActiveAiScreeningTask(status: ScreeningTaskStatus['status']): boolean {
  return ACTIVE_AI_SCREENING_TASK_STATUSES.has(status);
}

/**
 * Row "AI Screening Running" and the Pipeline tab badge: pending screening rows
 * (screenings SSE), the click optimistic set, and active AI Workforce tasks
 * (tasks SSE — needed when a pending_scan run has not created screening rows yet).
 */
export function mergeRunningScreeningCompanyIds(
  pendingFromScreenings: Iterable<string>,
  starting: Iterable<string>,
  tasks: ScreeningTaskStatus[],
): Set<string> {
  const ids = new Set([...pendingFromScreenings, ...starting]);
  for (const task of tasks) {
    if (isActiveAiScreeningTask(task.status)) ids.add(task.companyId);
  }
  return ids;
}
