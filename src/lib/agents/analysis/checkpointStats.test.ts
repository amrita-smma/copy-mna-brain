import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  beginCheckpointStats,
  resetCheckpointStatsForTests,
  withCheckpointStats,
} from './checkpointStats';

const put = vi.fn();
const putWrites = vi.fn();

function fakeSaver() {
  return { put, putWrites } as unknown as BaseCheckpointSaver;
}

const forThread = (threadId: string) => ({ configurable: { thread_id: threadId } });
const checkpointWith = (messages: number) => ({ channel_values: { messages: Array(messages).fill('m') } });

/** A clock that advances by the next queued step on every read. */
function steppedClock(steps: number[]) {
  let t = 0;
  let i = 0;
  return () => {
    t += steps[i++] ?? 0;
    return t;
  };
}

describe('withCheckpointStats', () => {
  beforeEach(() => {
    resetCheckpointStatsForTests();
    put.mockReset().mockResolvedValue({ configurable: { checkpoint_id: 'cp' } });
    putWrites.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('counts and times the writes of a thread with an open collector, and passes results through', async () => {
    // put: start 0, end 30 (30 ms); putWrites: start 0, end 5 (5 ms); put: 0 → 12 (12 ms).
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 30, 0, 5, 0, 12]));
    const turn = beginCheckpointStats('t1');

    await expect(saver.put(forThread('t1'), checkpointWith(4) as never, {} as never, {})).resolves.toEqual({
      configurable: { checkpoint_id: 'cp' },
    });
    await saver.putWrites(forThread('t1'), [], 'task');
    await saver.put(forThread('t1'), checkpointWith(6) as never, {} as never, {});

    expect(turn.end()).toEqual({
      checkpoints: 2,
      writeBatches: 1,
      totalMs: 47,
      maxMs: 30,
      lastCheckpointMessages: 6,
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(putWrites).toHaveBeenCalledTimes(1);
  });

  it('ignores writes on a thread with no open collector', async () => {
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 100]));
    const turn = beginCheckpointStats('t1');

    await saver.put(forThread('other'), checkpointWith(1) as never, {} as never, {});
    await saver.putWrites({ configurable: {} }, [], 'task');

    expect(turn.end()).toEqual({ checkpoints: 0, writeBatches: 0, totalMs: 0, maxMs: 0, lastCheckpointMessages: null });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent threads apart', async () => {
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 1, 0, 2]));
    const a = beginCheckpointStats('a');
    const b = beginCheckpointStats('b');

    await saver.put(forThread('a'), checkpointWith(1) as never, {} as never, {});
    await saver.put(forThread('b'), checkpointWith(9) as never, {} as never, {});

    expect(a.end()).toMatchObject({ checkpoints: 1, totalMs: 1, lastCheckpointMessages: 1 });
    expect(b.end()).toMatchObject({ checkpoints: 1, totalMs: 2, lastCheckpointMessages: 9 });
  });

  it('stops counting once the collector is ended, and a later end returns the same totals', async () => {
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 3, 0, 50]));
    const turn = beginCheckpointStats('t1');
    await saver.put(forThread('t1'), checkpointWith(1) as never, {} as never, {});

    const first = turn.end();
    await saver.put(forThread('t1'), checkpointWith(2) as never, {} as never, {});

    expect(first).toMatchObject({ checkpoints: 1, totalMs: 3 });
    expect(turn.end()).toEqual(first);
  });

  it('times a failed write and lets the failure through', async () => {
    put.mockRejectedValue(new Error('pool exhausted'));
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 7]));
    const turn = beginCheckpointStats('t1');

    await expect(saver.put(forThread('t1'), checkpointWith(1) as never, {} as never, {})).rejects.toThrow(
      'pool exhausted',
    );

    expect(turn.end()).toMatchObject({ checkpoints: 1, totalMs: 7, maxMs: 7 });
  });

  it('replaces a collector left open on the same thread', async () => {
    const saver = withCheckpointStats(fakeSaver(), steppedClock([0, 1]));
    const stale = beginCheckpointStats('t1');
    const fresh = beginCheckpointStats('t1');

    await saver.put(forThread('t1'), checkpointWith(1) as never, {} as never, {});

    expect(stale.end()).toMatchObject({ checkpoints: 0 });
    expect(fresh.end()).toMatchObject({ checkpoints: 1 });
  });

  it('leaves a saver without the methods alone', () => {
    const bare = {} as unknown as BaseCheckpointSaver;
    expect(withCheckpointStats(bare)).toBe(bare);
    expect((bare as unknown as { put?: unknown }).put).toBeUndefined();
  });
});
