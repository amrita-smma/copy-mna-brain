import { JobRepository, ScreeningRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { JobService } from '@/lib/services/jobService';
import { runJob } from './runner';

/**
 * In-app scheduler for the stuck-job cleanup sweep. Triggered on cold start
 * (via instrumentation.ts) and opportunistically on every dispatchJob call.
 *
 * Serverless constraint: setInterval doesn't survive function freezes, so we
 * rely on these request-adjacent triggers instead. The 24h DB window ensures
 * we never run the cleanup more than once per day regardless of trigger cadence.
 *
 * Each run is recorded as a normal `stuck_cleanup` job row with job_logs
 * transitions, matching the async-task rule in CLAUDE.md.
 */

export const CLEANUP_WINDOW_SECONDS = 24 * 60 * 60;
const CLEANUP_JOB_TIMEOUT_SECONDS = 300;

// Per-process guard: once a scheduler run is in flight for this instance,
// skip further triggers until it finishes. Prevents double-work when a cold
// start triggers register() and the same instance immediately handles a job
// dispatch that also calls the scheduler.
let inFlight: Promise<boolean> | null = null;

export interface SchedulerRunOptions {
  windowSeconds?: number;
  now?: () => number;
}

/**
 * Runs the cleanup sweep if the last one was longer than `windowSeconds` ago.
 * Returns true when a sweep actually ran, false when skipped.
 */
export function runSchedulerIfDue(
  db: DbClient,
  options: SchedulerRunOptions = {},
): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = execute(db, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function execute(db: DbClient, options: SchedulerRunOptions): Promise<boolean> {
  const windowSeconds = options.windowSeconds ?? CLEANUP_WINDOW_SECONDS;
  const now = options.now ?? Date.now;

  const jobRepo = new JobRepository(db);
  const cutoff = new Date(now() - windowSeconds * 1000).toISOString();

  const recent = await jobRepo.findMostRecentByType('stuck_cleanup', cutoff);
  if (recent) return false;

  const created = await jobRepo.create({
    type: 'stuck_cleanup',
    payload: {},
    timeout_seconds: CLEANUP_JOB_TIMEOUT_SECONDS,
  });

  await runJob(jobRepo, created.id, created.timeout_seconds * 1000, async () => {
    const screeningRepo = new ScreeningRepository(db);
    const service = new JobService(jobRepo, screeningRepo);
    return service.cleanupStuckJobs();
  });

  return true;
}

/** Test-only. Resets the per-process guard between tests. */
export function __resetSchedulerForTests(): void {
  inFlight = null;
}
