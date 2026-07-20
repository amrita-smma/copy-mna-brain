/**
 * Next.js server-side instrumentation. Runs once per Node runtime init, i.e.
 * once per serverless cold start. We use this hook to fire the stuck-job
 * cleanup scheduler. The 24h DB window inside the scheduler prevents repeat
 * runs when cold starts happen frequently.
 *
 * Fire-and-forget on purpose: we don't want to block cold-start latency for
 * the first request. If the serverless platform terminates the process
 * before the sweep finishes, the next cold start retries.
 */


export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;



  const [{ runSchedulerIfDue }, { createDb }] = await Promise.all([
    import('@/lib/jobs/scheduler'),
    import('@/lib/server/db'),
  ]);

  runSchedulerIfDue(createDb()).catch((err) => {
    console.error('[instrumentation] stuck-cleanup scheduler failed:', err);
  });
}
