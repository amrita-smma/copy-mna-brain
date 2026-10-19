import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
  WorkspaceRepository,
  type DbClient,
} from '@/lib/repositories';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';

/**
 * Email the run's owner that it failed. For the failure paths that sit outside
 * runAgent's `markFailedStep` — the stuck-run reaper and a run that died
 * before its first step loaded — so every way a run can fail on its own ends
 * in the same email. Best-effort: the notifier swallows its own errors.
 *
 * `workspaceId` must be the run's own workspace (RoutinesRepository.findById
 * is workspace-scoped, and a cron run's recipient is its routine's creator).
 */
export async function notifyRunFailed(
  db: DbClient,
  workspaceId: string,
  runId: string,
  reason: string | undefined,
): Promise<boolean> {
  return new EmailNotificationService({
    workforceRepo: new AiWorkforceQueueRepository(db, workspaceId),
    routinesRepo: new RoutinesRepository(db, workspaceId),
    userRepo: new UserRepository(db),
    workspaceRepo: new WorkspaceRepository(db),
  }).notifyTaskFailed(runId, { cancelled: false, reason });
}
