import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

/** A burst of tool calls becomes one frame: publishes wait this long for more. */
export const LIVE_TRACE_COALESCE_MS = 1_000;

type Publish = typeof publishLiveEvent;

/**
 * Announces a workforce run's trace as it grows. The trace the AI Workforce
 * canvases draw is the run's checkpoint (every model reply and tool result),
 * which LangGraph writes as the agent goes — nothing in our code sees those
 * writes, so this handler rides the run's LangChain callbacks and publishes
 * `workforce [runId]` after each model reply and tool result, coalesced so a
 * burst of tool calls is one frame. The run's own finish steps publish the
 * terminal status; this is only the in-flight part.
 */
export class LiveTraceCallbackHandler extends BaseCallbackHandler {
  name = 'workforce_live_trace';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly runId: string,
    private readonly publish: Publish = publishLiveEvent,
    private readonly coalesceMs: number = LIVE_TRACE_COALESCE_MS,
  ) {
    super();
  }

  handleLLMEnd(): void {
    this.schedule();
  }

  handleLLMError(): void {
    this.schedule();
  }

  handleToolEnd(): void {
    this.schedule();
  }

  handleToolError(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const timer = setTimeout(() => {
      this.timer = null;
      void this.publish(this.workspaceId, LIVE_TOPICS.workforce, [this.runId]).catch((err: unknown) => {
        console.error('[workforce] live trace publish failed:', err);
      });
    }, this.coalesceMs);
    // Never keeps a process alive for a frame nobody is waiting on.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }
}
