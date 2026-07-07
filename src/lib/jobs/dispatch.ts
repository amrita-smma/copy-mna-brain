import { after } from 'next/server';
import { JobRepository } from '@/lib/repositories';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';
import { runJob } from './runner';

export type JobType = Tables<'jobs'>['type'];

/**
 * Create a job row immediately and schedule its work to run after the HTTP
 * response is sent. Returns the jobId so the handler can respond with 202.
 *
 * The work function is invoked with the job row and a fresh DbClient (the
 * one from the request may close after the response). It should return a
 * JSON-serializable value which will be stored on jobs.result.
 */
export async function dispatchJob<T>(opts: {
  db: DbClient;
  createDb: () => DbClient;
  type: JobType;
  payload: Record<string, unknown>;
  timeoutSeconds: number;
  work: (ctx: { job: Tables<'jobs'>; db: DbClient }) => Promise<T>;
  /** Omitted by pipeline/cron callers that dispatch outside a workspace context — `jobs.workspace_id` stays NULL. */
  workspaceId?: string;
}): Promise<{ jobId: string }> {
  const jobRepo = new JobRepository(opts.db);

  const insert: TablesInsert<'jobs'> = {
    type: opts.type,
    payload: opts.payload as Tables<'jobs'>['payload'],
    timeout_seconds: opts.timeoutSeconds,
    workspace_id: opts.workspaceId ?? null,
  };

  const job = await jobRepo.create(insert);

  after(async () => {
    const db = opts.createDb();
    const runnerRepo = new JobRepository(db);
    await runJob(runnerRepo, job.id, opts.timeoutSeconds * 1000, async (current) =>
      opts.work({ job: current, db }),
    );
  });

  // Skip recursive scheduler trigger: the sweep itself is dispatched via the
  // scheduler path (not dispatchJob), so a normal dispatch won't re-enter.
  // But when a stuck_cleanup row is somehow dispatched here, avoid looping.
  if (opts.type !== 'stuck_cleanup') {
    after(async () => {
      try {
        const { runSchedulerIfDue } = await import('./scheduler');
        await runSchedulerIfDue(opts.createDb());
      } catch (err) {
        console.error('[dispatch] scheduler trigger failed:', err);
      }
    });
  }

  return { jobId: job.id };
}
