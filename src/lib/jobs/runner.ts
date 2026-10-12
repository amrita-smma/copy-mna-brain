import { JobRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { flushLangfuse } from '@/lib/langfuse';

export class JobTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Job exceeded timeout of ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * Run a job to terminal state. Never throws — always persists the final status
 * (completed / failed / timed_out) and the result or error message.
 */
export async function runJob<T>(
  jobRepo: JobRepository,
  jobId: string,
  timeoutMs: number,
  work: (job: Tables<'jobs'>) => Promise<T>,
): Promise<void> {
  let running: Tables<'jobs'>;
  try {
    running = await jobRepo.markRunning(jobId);
  } catch (err) {
    console.error(`[jobs] Failed to mark job ${jobId} running:`, err);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const result = await Promise.race([work(running), timeoutPromise]);
    await jobRepo.markCompleted(jobId, result);
  } catch (err) {
    try {
      if (err instanceof JobTimeoutError) {
        await jobRepo.markTimedOut(jobId, err.message);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await jobRepo.markFailed(jobId, message);
      }
    } catch (persistErr) {
      console.error(`[jobs] Failed to persist terminal state for ${jobId}:`, persistErr);
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Every agent-running handler funnels through here, and Langfuse's
    // LangChain callbacks are fire-and-forget. Without this drain the serverless
    // function can be frozen with the turn's events still queued, so background
    // work (company analysis, AI screening, file processing) would be the one
    // thing missing from the traces. Awaited, not `after()`: a job handler is
    // not always running inside a request whose lifetime `after` extends.
    await flushLangfuse();
  }
}
