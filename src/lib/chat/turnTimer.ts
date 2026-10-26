/**
 * Per-turn timing for the chat route's setup path.
 *
 * `POST /api/chat` does a long run of sequential work before the model is
 * even called — thread open, context reads, memory recall, effort routing,
 * the turn lock, the history read, the repairs — and until this existed none
 * of it was measured, so "the copilot is slow" could not be broken down. One
 * timer is created per turn; the route calls `mark()` as each stage finishes
 * and `log()` once the first model token arrives, which prints a single line
 * with the elapsed time at each stage.
 *
 * Stage times are **cumulative** milliseconds since the timer was created, not
 * per-stage durations, so the line reads as a timeline and the gaps are the
 * stage costs. Marks are idempotent on first write: a stage is recorded once,
 * at the moment it first finishes.
 */

export type TurnStage =
  | 'auth'
  | 'body'
  | 'thread_open'
  | 'context'
  | 'router'
  | 'memory_recall'
  | 'attachments'
  | 'graph_resolved'
  | 'turn_claimed'
  | 'history_read'
  | 'question_stored'
  | 'repairs'
  | 'stream_opened'
  | 'model_started'
  | 'first_token'
  | 'first_text';

export interface TurnTimerSink {
  (line: string): void;
}

export class TurnTimer {
  private readonly startedAt: number;
  private readonly marks = new Map<TurnStage, number>();
  private logged = false;

  constructor(
    private readonly label: string,
    private readonly now: () => number = () => performance.now(),
    private readonly sink: TurnTimerSink = (line) => console.log(line),
  ) {
    this.startedAt = this.now();
  }

  /** Record that `stage` has just finished. The first call for a stage wins. */
  mark(stage: TurnStage): void {
    if (this.marks.has(stage)) return;
    this.marks.set(stage, Math.round(this.now() - this.startedAt));
  }

  /** Elapsed milliseconds at `stage`, or null when it never finished. */
  at(stage: TurnStage): number | null {
    return this.marks.get(stage) ?? null;
  }

  /** The recorded stages in the order they finished. */
  stages(): Record<string, number> {
    return Object.fromEntries(
      [...this.marks.entries()].sort((a, b) => a[1] - b[1]),
    );
  }

  /**
   * Print the timeline once. Later calls are no-ops, so the route can call it
   * from whichever of "first token" / "turn ended" fires first.
   */
  log(): void {
    if (this.logged) return;
    this.logged = true;
    const total = Math.round(this.now() - this.startedAt);
    this.sink(`[chat] ${this.label} timeline total=${total}ms stages=${JSON.stringify(this.stages())}`);
  }
}
