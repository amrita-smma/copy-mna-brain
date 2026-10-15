import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  createContainer: vi.fn(),
  dispatchScan: vi.fn(),
  requeueScan: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  AutoScanQueueRepository: class {
    claim = mocks.claim;
  },
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: mocks.createContainer,
}));

import { drainPendingAutoScanQueue } from './pendingAutoScanQueue';

const db = {} as never;

describe('drainPendingAutoScanQueue', () => {
  beforeEach(() => {
    mocks.claim.mockReset();
    mocks.dispatchScan.mockReset().mockResolvedValue({ jobId: 'j' });
    mocks.requeueScan.mockReset().mockResolvedValue(1);
    mocks.createContainer.mockReset().mockReturnValue({
      pendingAutoScanService: {
        dispatchScan: mocks.dispatchScan,
        requeueScan: mocks.requeueScan,
      },
    });
  });

  it('builds no container when the queue is empty', async () => {
    mocks.claim.mockResolvedValue([]);

    await expect(drainPendingAutoScanQueue(db)).resolves.toEqual({
      claimed: 0,
      dispatched: 0,
      failed: 0,
    });
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it('dispatches each claimed company in its own workspace', async () => {
    mocks.claim.mockResolvedValue([
      { companyId: 'c-1', workspaceId: 'ws-1', force: false },
      { companyId: 'c-2', workspaceId: 'ws-2', force: true },
    ]);

    await expect(drainPendingAutoScanQueue(db, 2)).resolves.toEqual({
      claimed: 2,
      dispatched: 2,
      failed: 0,
    });
    expect(mocks.claim).toHaveBeenCalledWith(2);
    expect(mocks.createContainer).toHaveBeenNthCalledWith(1, db, 'ws-1');
    expect(mocks.createContainer).toHaveBeenNthCalledWith(2, db, 'ws-2');
    expect(mocks.dispatchScan).toHaveBeenNthCalledWith(1, 'c-1', false);
    expect(mocks.dispatchScan).toHaveBeenNthCalledWith(2, 'c-2', true);
  });

  it('keeps going when one dispatch fails and re-queues that company', async () => {
    mocks.claim.mockResolvedValue([
      { companyId: 'c-1', workspaceId: 'ws-1', force: false },
      { companyId: 'c-2', workspaceId: 'ws-1', force: true },
    ]);
    mocks.dispatchScan.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(drainPendingAutoScanQueue(db)).resolves.toEqual({
      claimed: 2,
      dispatched: 1,
      failed: 1,
    });
    expect(mocks.requeueScan).toHaveBeenCalledWith('c-1', false);
    expect(mocks.dispatchScan).toHaveBeenNthCalledWith(2, 'c-2', true);
    errorSpy.mockRestore();
  });
});
