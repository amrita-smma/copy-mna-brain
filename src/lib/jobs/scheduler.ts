import { JobRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { JobService } from '@/lib/services/jobService';
import { runJob } from './runner';

/**
 * Scheduler for the stuck-job cleanup sweep. Triggered by Vercel Cron, which
 * hits `GET /api/cron/cleanup-jobs` hourly (see vercel.json); the 24h DB
 * window turns that into at most one sweep per day.
 *
 * It used to fire fire-and-forget from `instrumentation.ts` on every cold
 * start. That path ran outside any request, so the instance could be frozen
 * mid-connect, and it queried the DB on every cold start even when the window
 * said skip — surfacing as frequent "Connection terminated due to connection
 * timeout" errors. Don't reintroduce a cold-start or per-dispatch trigger.
 *
 * Each run is recorded as a normal `stuck_cleanup` job row with job_logs
 * transitions, matching the async-task rule in CLAUDE.md.
 */

export const CLEANUP_WINDOW_SECONDS = 24 * 60 * 60;
const CLEANUP_JOB_TIMEOUT_SECONDS = 300;

// Per-process guard: once a scheduler run is in flight for this instance,
// skip further triggers until it finishes. Prevents double-work when two
// requests to the cleanup route overlap on the same warm instance.
let inFlight: Promise<boolean> | null = null;

export interface SchedulerRunOptions {
  windowSeconds?: number;
  now?: () => number;
}

/**
 * Runs the cleanup sweep if the last one was longer than `windowSeconds` ago.
 * Returns true when a sweep actually ran, false when skipped.
 *
 * Skipped entirely on Vercel preview deployments: preview Neon branches are
 * ephemeral (created/torn down per-PR by preview-db.yml) and can be mid-spinup
 * or already deleted, which surfaces as password-auth or
 * connection-timeout errors here that have nothing to do with real stuck jobs.
 */
export function runSchedulerIfDue(
  db: DbClient,
  options: SchedulerRunOptions = {},
): Promise<boolean> {
  if (process.env.VERCEL_ENV === 'preview') return Promise.resolve(false);
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
    const service = new JobService(jobRepo, db);
    return service.cleanupStuckJobs();
  });

  return true;
}

/** Test-only. Resets the per-process guard between tests. */
export function __resetSchedulerForTests(): void {
  inFlight = null;
}
