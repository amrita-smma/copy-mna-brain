import { after } from 'next/server';
import { JobRepository } from '@/lib/repositories';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';
import { runJob } from './runner';
import { withBackgroundDb } from '@/lib/server/db';

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
    await withBackgroundDb(async (db) => {
      const runnerRepo = new JobRepository(db);
      await runJob(runnerRepo, job.id, opts.timeoutSeconds * 1000, async (current) =>
        opts.work({ job: current, db }),
      );
    });
  });

  return { jobId: job.id };
}

/**
 * Create a job row and run its work to a terminal state *now*, in the calling
 * process, resolving once it has finished. For work that is already running
 * in the background (inside another job) and wants a child job row of its own
 * — `after()` is not available there, and the row keeps the child visible to
 * the existing progress views and the stuck-job sweep.
 *
 * Like `runJob`, never throws for a failed work function; the outcome is on
 * the job row (and, for AI screening, on the screening row it writes).
 */
export async function runJobInline<T>(opts: {
  db: DbClient;
  type: JobType;
  payload: Record<string, unknown>;
  timeoutSeconds: number;
  work: (ctx: { job: Tables<'jobs'>; db: DbClient }) => Promise<T>;
  workspaceId?: string;
}): Promise<{ jobId: string }> {
  const jobRepo = new JobRepository(opts.db);
  const job = await jobRepo.create({
    type: opts.type,
    payload: opts.payload as Tables<'jobs'>['payload'],
    timeout_seconds: opts.timeoutSeconds,
    workspace_id: opts.workspaceId ?? null,
  });
  await runJob(jobRepo, job.id, opts.timeoutSeconds * 1000, async (current) =>
    opts.work({ job: current, db: opts.db }),
  );
  return { jobId: job.id };
}
