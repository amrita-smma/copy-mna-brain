import { JobRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { JobService } from '@/lib/services/jobService';
import { runJob } from './runner';

/**
 * In-app scheduler for the stuck-job cleanup sweep. Triggered solely on cold
 * start (via instrumentation.ts) — not opportunistically from dispatchJob,
 * since piggybacking the sweep on every job dispatch multiplied the number of
 * DB connections made under load and made production connection timeouts
 * more likely.
 *
 * Serverless constraint: setInterval doesn't survive function freezes, so we
 * rely on the cold-start trigger instead. The 24h DB window ensures we never
 * run the cleanup more than once per day regardless of cold-start cadence.
 *
 * Each run is recorded as a normal `stuck_cleanup` job row with job_logs
 * transitions, matching the async-task rule in CLAUDE.md.
 */

export const CLEANUP_WINDOW_SECONDS = 24 * 60 * 60;
const CLEANUP_JOB_TIMEOUT_SECONDS = 300;

// Per-process guard: once a scheduler run is in flight for this instance,
// skip further triggers until it finishes. Prevents double-work when a cold
// start's register() overlaps with another in-flight cold start on the same
// warm instance.
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
 * or already deleted on a cold start, which surfaces as password-auth or
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
