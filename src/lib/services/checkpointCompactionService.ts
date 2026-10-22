import type { AgentCheckpointRepository, CompactionResult } from '@/lib/repositories';

/** Checkpoints kept per thread: the latest state plus its parent. */
export const CHECKPOINTS_TO_KEEP = 2;
/** A thread is only compacted once it has been idle this long. */
export const COMPACTION_IDLE_MINUTES = 15;
/** Threads compacted per run; the rest wait for the next run. */
export const COMPACTION_BATCH = 200;

export interface CompactionRunResult extends CompactionResult {
  threads: number;
  failed: number;
}

/**
 * LangGraph checkpoint auto-compaction. Every step of every turn writes a
 * checkpoint, and nothing used to delete them, so `agent_states` grew without
 * bound — worst on a bot's permanent thread. The chat history the UI shows
 * lives in `copilot_messages` and the live state is in the newest checkpoint,
 * so older checkpoints are dead weight. Runs from the compact-checkpoints cron.
 */
export class CheckpointCompactionService {
  constructor(private readonly repo: AgentCheckpointRepository) {}

  async run({ batch = COMPACTION_BATCH }: { batch?: number } = {}): Promise<CompactionRunResult> {
    const threads = await this.repo.listCompactableThreads({
      keep: CHECKPOINTS_TO_KEEP,
      idleMinutes: COMPACTION_IDLE_MINUTES,
      limit: batch,
    });
    const total: CompactionRunResult = { threads: 0, failed: 0, checkpoints: 0, writes: 0, blobs: 0 };
    for (const threadId of threads) {
      try {
        const r = await this.repo.compactThread(threadId, CHECKPOINTS_TO_KEEP);
        total.threads++;
        total.checkpoints += r.checkpoints;
        total.writes += r.writes;
        total.blobs += r.blobs;
      } catch (err) {
        // One thread's failure must not stop the sweep.
        total.failed++;
        console.error(`[checkpoint-compaction] thread ${threadId} failed:`, err);
      }
    }
    return total;
  }
}
