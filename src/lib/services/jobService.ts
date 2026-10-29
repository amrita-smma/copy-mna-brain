import { ScreeningRepository, type DbClient, type JobRepository, type Tables } from '@/lib/repositories';
import { DEFAULT_STUCK_BUFFER_SECONDS, buildStuckReason } from '@/lib/jobs/stuck';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

export interface StuckJobCleanupResult {
  cleaned: number;
  failed: number;
  jobIds: string[];
}

type Job = Tables<'jobs'>;

export class JobService {
  /**
   * @param db `findStuck()` sweeps jobs across every workspace (it's a
   *   global maintenance job, not scoped to one request), so each stuck
   *   `ai_screening` job's `ScreeningRepository` is built per-job from its
   *   own `workspace_id` rather than a single bound instance.
   */
  constructor(
    private readonly jobRepo: JobRepository,
    private readonly db: DbClient,
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
        if (job.workspace_id) {
          await publishLiveEvent(job.workspace_id, LIVE_TOPICS.jobs, [job.id]);
        }
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
      const workspaceId = job.workspace_id ?? (await getActiveWorkspaceId());
      const screeningRepo = new ScreeningRepository(this.db, workspaceId);
      await screeningRepo.markFailedIfPending(
        screeningId,
        `Job ${job.id} marked as timed out: ${reason}`,
      );
      await publishLiveEvent(workspaceId, LIVE_TOPICS.screenings, [screeningId]);
    } catch (err) {
      console.error(`[jobs] failed to mirror screening for job ${job.id}:`, err);
    }
  }
}
