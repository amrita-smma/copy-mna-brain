import { JobRepository } from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';

type JobType = Tables<'jobs'>["type"];

/**
 * Create a jobs row, log each state transition to job_logs, then execute fn.
 * Marks the job completed or failed and logs the terminal transition.
 *
 * Mirrors the runJob / dispatchJob pattern but is adapted for Lambda where
 * there is no Next.js `after()` hook.
 */
export async function withJob<T>(
  db: DbClient,
  jobType: JobType,
  payload: unknown,
  fn: (deps: { db: DbClient; job: Tables<'jobs'> }) => Promise<T>,
): Promise<T> {
  const jobRepo = new JobRepository(db);

  const job = await jobRepo.create({
    type: jobType,
    payload: (payload ?? {}) as Tables<'jobs'>["payload"],
    timeout_seconds: 1800,
  });

  const running = await jobRepo.markRunning(job.id);
  await jobRepo.appendLog(job.id, {
    message: `Lambda started job ${job.id} type=${jobType}`,
    metadata: { payload },
  });

  let result: T;
  try {
    result = await fn({ db, job: running });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await jobRepo.markFailed(job.id, message);
      await jobRepo.appendLog(job.id, {
        message: `Lambda job ${job.id} failed: ${message}`,
        metadata: { error: message },
      });
    } catch (persistErr) {
      console.error(`[withJob] failed to persist failure for ${job.id}:`, persistErr);
    }
    throw err;
  }

  await jobRepo.markCompleted(job.id, result);
  await jobRepo.appendLog(job.id, {
    message: `Lambda job ${job.id} completed`,
    metadata: null,
  });
  return result;
}
