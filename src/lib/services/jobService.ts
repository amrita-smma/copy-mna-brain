import type { JobRepository, ScreeningRepository, Tables } from '@/lib/repositories';
import { DEFAULT_STUCK_BUFFER_SECONDS, buildStuckReason } from '@/lib/jobs/stuck';

export interface StuckJobCleanupResult {
  cleaned: number;
  failed: number;
  jobIds: string[];
}

type Job = Tables<'jobs'>;

export class JobService {
  constructor(
    private readonly jobRepo: JobRepository,
    private readonly screeningRepo: ScreeningRepository,
  ) {}

  findByIdWithLogs(id: string) {
    return this.jobRepo.findByIdWithLogs(id);
  }

  async cleanupStuckJobs(
    bufferSeconds: number = DEFAULT_STUCK_BUFFER_SECONDS,
  ): Promise<StuckJobCleanupResult> {
    const stuck = await this.jobRepo.findStuck(bufferSeconds);
    const jobIds: string[] = [];
    let failed = 0;
    for (const job of stuck) {
      try {
        const reason = buildStuckReason(job);
        await this.jobRepo.markStuckAsTimedOut(job.id, reason);
        await this.mirrorTerminalJobToSideRecord(job, reason);
        jobIds.push(job.id);
      } catch (err) {
        failed += 1;
        console.error(`[jobs] failed to cleanup stuck job ${job.id}:`, err);
      }
    }
    return { cleaned: jobIds.length, failed, jobIds };
  }

  private async mirrorTerminalJobToSideRecord(job: Job, reason: string): Promise<void> {
    if (job.type !== 'ai_screening') return;
    const payload = job.payload as Record<string, unknown> | null;
    const screeningId = payload?.screeningId;
    if (typeof screeningId !== 'string' || !screeningId) return;
    try {
      await this.screeningRepo.markFailedIfPending(
        screeningId,
        `Job ${job.id} marked as timed out: ${reason}`,
      );
    } catch (err) {
      console.error(`[jobs] failed to mirror screening for job ${job.id}:`, err);
    }
  }
}
