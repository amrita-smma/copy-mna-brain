import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoScanQueueRepository } from './autoScanQueueRepository';

const mockDb = { execute: vi.fn() };

describe('AutoScanQueueRepository.claim', () => {
  beforeEach(() => {
    mockDb.execute.mockReset();
  });

  it('returns [] without hitting the DB for a non-positive limit', async () => {
    const repo = new AutoScanQueueRepository(mockDb as never);
    await expect(repo.claim(0)).resolves.toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('maps claimed rows, keeping the force flag they were queued with', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        { id: 'c1', workspace_id: 'w1', auto_scan_force: true },
        { id: 'c2', workspace_id: 'w2', auto_scan_force: false },
      ],
    });
    const repo = new AutoScanQueueRepository(mockDb as never);

    await expect(repo.claim(3)).resolves.toEqual([
      { companyId: 'c1', workspaceId: 'w1', force: true },
      { companyId: 'c2', workspaceId: 'w2', force: false },
    ]);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });
});
