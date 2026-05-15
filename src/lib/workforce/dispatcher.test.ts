import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hasRunning, claimNextRunnable, findStuckRunning, markFailed, triggerWorkflowForRun } =
  vi.hoisted(() => ({
    hasRunning: vi.fn(),
    claimNextRunnable: vi.fn(),
    findStuckRunning: vi.fn(),
    markFailed: vi.fn(),
    triggerWorkflowForRun: vi.fn(),
  }));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    hasRunning = hasRunning;
    claimNextRunnable = claimNextRunnable;
    findStuckRunning = findStuckRunning;
    markFailed = markFailed;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

vi.mock('./workflowTrigger', () => ({ triggerWorkflowForRun }));

import { dispatcherTick, reapStuckRuns } from './dispatcher';

const fakeDb = {} as never;

describe('dispatcherTick', () => {
  beforeEach(() => {
    hasRunning.mockReset();
    claimNextRunnable.mockReset();
    triggerWorkflowForRun.mockReset();
    triggerWorkflowForRun.mockResolvedValue(undefined);
  });

  it('returns running_already without claiming when a row is already running', async () => {
    hasRunning.mockResolvedValueOnce(true);

    const result = await dispatcherTick(fakeDb);

    expect(result).toEqual({ outcome: 'running_already' });
    expect(claimNextRunnable).not.toHaveBeenCalled();
    expect(triggerWorkflowForRun).not.toHaveBeenCalled();
  });

  it('returns empty when claim returns null (queue empty or lock contended)', async () => {
    hasRunning.mockResolvedValueOnce(false);
    claimNextRunnable.mockResolvedValueOnce(null);

    const result = await dispatcherTick(fakeDb);

    expect(result).toEqual({ outcome: 'empty' });
    expect(triggerWorkflowForRun).not.toHaveBeenCalled();
  });

  it('fires the workflow trigger and returns the claimed runId on success', async () => {
    hasRunning.mockResolvedValueOnce(false);
    claimNextRunnable.mockResolvedValueOnce({ id: 'r-1' });

    const result = await dispatcherTick(fakeDb);

    expect(result).toEqual({ outcome: 'claimed', runId: 'r-1' });
    expect(triggerWorkflowForRun).toHaveBeenCalledWith('r-1');
  });
});

describe('reapStuckRuns', () => {
  beforeEach(() => {
    findStuckRunning.mockReset();
    markFailed.mockReset();
    markFailed.mockResolvedValue({});
  });

  afterEach(() => vi.useRealTimers());

  it('returns empty results when no stuck rows exist', async () => {
    findStuckRunning.mockResolvedValueOnce([]);

    const result = await reapStuckRuns(fakeDb);

    expect(result).toEqual({ reaped: [], scanned: 0 });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('marks each stuck row as failed with a stuck_no_heartbeat code', async () => {
    findStuckRunning.mockResolvedValueOnce([
      { id: 'r-1', last_heartbeat_at: '2026-05-12T00:00:00Z' },
      { id: 'r-2', last_heartbeat_at: '2026-05-12T00:00:00Z' },
    ]);

    const result = await reapStuckRuns(fakeDb, {
      stalenessSeconds: 60,
      now: () => new Date('2026-05-12T01:00:00Z'),
    });

    expect(result).toEqual({ reaped: ['r-1', 'r-2'], scanned: 2 });
    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(markFailed).toHaveBeenCalledWith(
      'r-1',
      expect.objectContaining({ code: 'stuck_no_heartbeat' }),
    );
  });

  it('uses now() - stalenessSeconds as the heartbeat cutoff', async () => {
    findStuckRunning.mockResolvedValueOnce([]);

    const fakeNow = new Date('2026-05-12T12:00:00Z');
    await reapStuckRuns(fakeDb, {
      stalenessSeconds: 300,
      now: () => fakeNow,
    });

    const expectedCutoff = new Date('2026-05-12T11:55:00Z').toISOString();
    expect(findStuckRunning).toHaveBeenCalledWith(expectedCutoff);
  });

  it('continues reaping subsequent rows when one mark fails', async () => {
    findStuckRunning.mockResolvedValueOnce([
      { id: 'r-1', last_heartbeat_at: '2026-05-12T00:00:00Z' },
      { id: 'r-2', last_heartbeat_at: '2026-05-12T00:00:00Z' },
    ]);
    markFailed.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});

    const result = await reapStuckRuns(fakeDb, {
      stalenessSeconds: 60,
      now: () => new Date('2026-05-12T01:00:00Z'),
    });

    expect(result).toEqual({ reaped: ['r-2'], scanned: 2 });
  });
});

describe('reaper failure detection', () => {
  // Verifies the reaper picks up rows whose heartbeat has gone cold —
  // i.e. workflow crashed after claim but before finalize, or the WDK
  // runtime stopped reporting. Happy-path runs heartbeat + complete fast
  // enough to be marked succeeded before this triggers.
  it('a row claimed long enough ago without heartbeat updates looks stuck', async () => {
    const claimedAt = new Date('2026-05-12T10:00:00Z');
    const reaperRunAt = new Date('2026-05-12T10:10:00Z'); // +10 min
    findStuckRunning.mockResolvedValueOnce([
      { id: 'r-stuck', last_heartbeat_at: claimedAt.toISOString() },
    ]);

    const result = await reapStuckRuns(fakeDb, {
      stalenessSeconds: 5 * 60,
      now: () => reaperRunAt,
    });

    expect(result.reaped).toEqual(['r-stuck']);
  });
});
