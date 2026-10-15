import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  processCompany: vi.fn(),
}));

vi.mock('@/lib/services/container', () => ({
  createContainer: mocks.createContainer,
}));

import { runPendingAutoScan } from './pendingAutoScan';

const db = {} as never;
const job = { id: 'job-1' } as never;

describe('runPendingAutoScan', () => {
  beforeEach(() => {
    mocks.createContainer.mockReset().mockReturnValue({
      pendingAutoScanService: { processCompany: mocks.processCompany },
    });
    mocks.processCompany.mockReset().mockResolvedValue({ companyId: 'c-1', outcome: 'scanned' });
  });

  it('processes the company in its own workspace container, passing the job id', async () => {
    await expect(
      runPendingAutoScan({ companyId: 'c-1', force: true, workspaceId: 'ws-1' }, { db, job }),
    ).resolves.toEqual({ companyId: 'c-1', outcome: 'scanned' });

    expect(mocks.createContainer).toHaveBeenCalledWith(db, 'ws-1');
    expect(mocks.processCompany).toHaveBeenCalledWith('c-1', { force: true, jobId: 'job-1' });
  });

  it('rejects a payload without a workspace', async () => {
    await expect(
      runPendingAutoScan({ companyId: 'c-1', force: false } as never, { db, job }),
    ).rejects.toThrow('workspaceId');
    expect(mocks.processCompany).not.toHaveBeenCalled();
  });
});
