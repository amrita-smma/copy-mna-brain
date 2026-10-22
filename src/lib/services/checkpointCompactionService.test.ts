import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHECKPOINTS_TO_KEEP,
  COMPACTION_IDLE_MINUTES,
  CheckpointCompactionService,
} from './checkpointCompactionService';

const repo = vi.hoisted(() => ({ listCompactableThreads: vi.fn(), compactThread: vi.fn() }));

describe('CheckpointCompactionService.run', () => {
  beforeEach(() => {
    repo.listCompactableThreads.mockReset();
    repo.compactThread.mockReset();
  });

  it('compacts each idle thread down to the newest checkpoints and totals what it removed', async () => {
    repo.listCompactableThreads.mockResolvedValue(['t1', 't2']);
    repo.compactThread
      .mockResolvedValueOnce({ checkpoints: 10, writes: 30, blobs: 4 })
      .mockResolvedValueOnce({ checkpoints: 2, writes: 5, blobs: 1 });

    const result = await new CheckpointCompactionService(repo as never).run({ batch: 50 });

    expect(repo.listCompactableThreads).toHaveBeenCalledWith({
      keep: CHECKPOINTS_TO_KEEP,
      idleMinutes: COMPACTION_IDLE_MINUTES,
      limit: 50,
    });
    expect(repo.compactThread).toHaveBeenCalledWith('t1', CHECKPOINTS_TO_KEEP);
    expect(result).toEqual({ threads: 2, failed: 0, checkpoints: 12, writes: 35, blobs: 5 });
  });

  it('keeps going past a thread that fails', async () => {
    repo.listCompactableThreads.mockResolvedValue(['bad', 'good']);
    repo.compactThread
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ checkpoints: 1, writes: 0, blobs: 0 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new CheckpointCompactionService(repo as never).run();

    expect(result).toMatchObject({ threads: 1, failed: 1, checkpoints: 1 });
    spy.mockRestore();
  });
});
