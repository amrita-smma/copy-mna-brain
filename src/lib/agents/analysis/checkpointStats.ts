/**
 * What a chat turn spends writing its thread's checkpoint.
 *
 * Every model call and every tool call in a turn ends in a checkpoint write
 * (`put`), and every tool round in a batch of pending writes (`putWrites`),
 * each serialising the whole message list — on a long thread, tens of
 * thousands of tokens per write. Whether that is where a turn's time goes
 * could not be told from the request path's timeline, which ends at the
 * first streamed text. This counts and times the saver's writes for one turn
 * at a time per thread, and the route files the totals on the turn's
 * Langfuse trace (`recordTurnWrites`), next to the timeline.
 *
 * Scoping: a collector is opened per thread id for the duration of a turn
 * (`beginCheckpointStats`) and the wrapped saver (`withCheckpointStats`)
 * attributes each write to the collector of the thread it is for, read from
 * the run config. A thread runs one turn at a time (the turn lock), so one
 * collector per thread is enough; writes on a thread with no open collector
 * — a workforce run, a background bot turn, the repairs before the run —
 * cost one map lookup and are not counted.
 *
 * The same wrapper is also where a thread's writes can be *heard*
 * (`onCheckpointWrite`): a workforce run announces its trace to the live
 * stream from here, after the write that grew it, rather than from a
 * callback that fires before LangGraph has persisted the step.
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export interface CheckpointWriteStats {
  /** Checkpoints written (`put`) while the collector was open. */
  checkpoints: number;
  /** Pending-write batches (`putWrites`) while the collector was open. */
  writeBatches: number;
  /** Ms spent inside the saver, both kinds of write together. */
  totalMs: number;
  /** The slowest single write, ms. */
  maxMs: number;
  /**
   * Messages in the last checkpoint written, or null when none was. The
   * closest cheap proxy for what each write serialised.
   */
  lastCheckpointMessages: number | null;
}

interface Collector {
  stats: CheckpointWriteStats;
}

const collectors = new Map<string, Collector>();

type WriteListener = () => void;
const writeListeners = new Map<string, Set<WriteListener>>();

/**
 * Run `listener` after every successful checkpoint write (`put` or
 * `putWrites`) on `threadId`, until the returned function is called. A
 * failed write is not announced. Listeners run synchronously after the
 * write resolves; one that throws is logged and does not fail the write.
 */
export function onCheckpointWrite(threadId: string, listener: WriteListener): () => void {
  let set = writeListeners.get(threadId);
  if (!set) {
    set = new Set();
    writeListeners.set(threadId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && writeListeners.get(threadId) === set) writeListeners.delete(threadId);
  };
}

function notifyWrite(threadId: string | null): void {
  if (!threadId) return;
  writeListeners.get(threadId)?.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[checkpoint] write listener failed:', err);
    }
  });
}

function emptyStats(): CheckpointWriteStats {
  return { checkpoints: 0, writeBatches: 0, totalMs: 0, maxMs: 0, lastCheckpointMessages: null };
}

/**
 * Open a collector for `threadId`. A collector already open for the thread
 * (a turn that never called `end`) is replaced. `end` closes it and returns
 * the totals; later calls return the same totals and count nothing more.
 */
export function beginCheckpointStats(threadId: string): { end(): CheckpointWriteStats } {
  const collector: Collector = { stats: emptyStats() };
  collectors.set(threadId, collector);
  return {
    end() {
      if (collectors.get(threadId) === collector) collectors.delete(threadId);
      return { ...collector.stats };
    },
  };
}

function threadIdOf(config: unknown): string | null {
  const id = (config as { configurable?: { thread_id?: unknown } } | undefined)?.configurable?.thread_id;
  return typeof id === 'string' ? id : null;
}

function record(collector: Collector, elapsedMs: number): void {
  collector.stats.totalMs += elapsedMs;
  if (elapsedMs > collector.stats.maxMs) collector.stats.maxMs = elapsedMs;
}

/**
 * Wrap a saver's `put` and `putWrites` so each write is timed and counted on
 * the open collector of its thread, if any. Returns the same instance; a
 * write's result and its failure pass through unchanged. A method the saver
 * does not have is left alone.
 */
export function withCheckpointStats<T extends BaseCheckpointSaver>(
  saver: T,
  now: () => number = () => performance.now(),
): T {
  const target = saver as unknown as Record<string, unknown>;

  if (typeof target.put === 'function') {
    const put = (target.put as BaseCheckpointSaver['put']).bind(saver);
    target.put = async (...args: Parameters<BaseCheckpointSaver['put']>) => {
      const threadId = threadIdOf(args[0]);
      const collector = collectors.get(threadId ?? '');
      const started = collector ? now() : 0;
      try {
        const result = await put(...args);
        notifyWrite(threadId);
        return result;
      } finally {
        if (collector) {
          record(collector, now() - started);
          collector.stats.checkpoints += 1;
          const messages = (args[1]?.channel_values as { messages?: unknown } | undefined)?.messages;
          collector.stats.lastCheckpointMessages = Array.isArray(messages) ? messages.length : null;
        }
      }
    };
  }

  if (typeof target.putWrites === 'function') {
    const putWrites = (target.putWrites as BaseCheckpointSaver['putWrites']).bind(saver);
    target.putWrites = async (...args: Parameters<BaseCheckpointSaver['putWrites']>) => {
      const threadId = threadIdOf(args[0]);
      const collector = collectors.get(threadId ?? '');
      const started = collector ? now() : 0;
      try {
        const result = await putWrites(...args);
        notifyWrite(threadId);
        return result;
      } finally {
        if (collector) {
          record(collector, now() - started);
          collector.stats.writeBatches += 1;
        }
      }
    };
  }

  return saver;
}

/** Test seam: forget every open collector and write listener. */
export function resetCheckpointStatsForTests(): void {
  collectors.clear();
  writeListeners.clear();
}
