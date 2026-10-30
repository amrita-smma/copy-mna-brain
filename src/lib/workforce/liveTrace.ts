import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

/** A burst of checkpoint writes becomes one frame: a publish waits this long for more. */
export const LIVE_TRACE_COALESCE_MS = 1_000;

type Publish = typeof publishLiveEvent;

/**
 * Announces a workforce run's trace as it grows. The trace the AI Workforce
 * canvases draw is the run's checkpoint, which LangGraph writes as the agent
 * goes; `runAgent` hears those writes (`onCheckpointWrite`) and calls
 * `touch()` after each one, and this publishes `workforce-trace [runId]`
 * coalesced so a burst of writes is one frame. `stop()` flushes a pending
 * frame right away, inside the step, so the last write before a pause or a
 * finish is never lost to a frozen function. Status moves are the
 * `workforce` topic's and are published by the run's own finish steps.
 */
export class LiveTraceAnnouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly workspaceId: string,
    private readonly runId: string,
    private readonly publish: Publish = publishLiveEvent,
    private readonly coalesceMs: number = LIVE_TRACE_COALESCE_MS,
  ) {}

  /** A checkpoint write landed: announce it, with the next ones, shortly. */
  touch(): void {
    if (this.stopped || this.timer) return;
    const timer = setTimeout(() => {
      this.timer = null;
      void this.announce();
    }, this.coalesceMs);
    // Never keeps a process alive for a frame nobody is waiting on.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** No more frames after this; a frame still waiting goes out now. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.announce();
  }

  private async announce(): Promise<void> {
    try {
      await this.publish(this.workspaceId, LIVE_TOPICS.workforceTrace, [this.runId]);
    } catch (err) {
      console.error('[workforce] live trace publish failed:', err);
    }
  }
}
