import { dispatchJob, runJobInline } from '@/lib/jobs/dispatch';
import type { DbClient, Tables } from '@/lib/repositories';
import type { JobType } from '@/lib/jobs/dispatch';

export class JobDispatcher {
  /**
   * @param workspaceId Stamped onto every job this dispatcher creates. Jobs
   *   dispatched outside a request's workspace context (pipeline lambdas,
   *   the cron scheduler's own `stuck_cleanup` sweep) don't go through this
   *   class at all — they call `dispatchJob` directly and leave `jobs.workspace_id`
   *   `NULL`, which is correct: those job types run before/outside any single
   *   workspace's fan-out.
   */
  constructor(
    private readonly db: DbClient,
    private readonly createDb: () => DbClient,
    private readonly workspaceId: string,
  ) {}

  dispatch<T>(opts: {
    type: JobType;
    payload: Record<string, unknown>;
    timeoutSeconds: number;
    work: (ctx: { job: Tables<'jobs'>; db: DbClient }) => Promise<T>;
  }): Promise<{ jobId: string }> {
    return dispatchJob({
      db: this.db,
      createDb: this.createDb,
      workspaceId: this.workspaceId,
      ...opts,
    });
  }

  /**
   * Run a job to completion in the current process (see `runJobInline`). Use
   * only from code that is itself already running in the background.
   */
  runInline<T>(opts: {
    type: JobType;
    payload: Record<string, unknown>;
    timeoutSeconds: number;
    work: (ctx: { job: Tables<'jobs'>; db: DbClient }) => Promise<T>;
  }): Promise<{ jobId: string }> {
    return runJobInline({ db: this.db, workspaceId: this.workspaceId, ...opts });
  }
}
