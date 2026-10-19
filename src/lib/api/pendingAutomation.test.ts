import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getPendingAutomation, savePendingAutomation, scanPendingNow } from './pendingAutomation';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({});
});

describe('pending automation client', () => {
  it('reads the active workspace toggles', async () => {
    await getPendingAutomation();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pending-automation');
  });

  it('saves both toggles in one PUT', async () => {
    await savePendingAutomation({ autoScan: true, autoPromote: false, autoDrop: true });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pending-automation', {
      method: 'PUT',
      body: JSON.stringify({ autoScan: true, autoPromote: false, autoDrop: true }),
    });
  });

  it('starts a scan of every pending company with a POST', async () => {
    apiRequestMock.mockResolvedValueOnce({ queued: 4, alreadyQueued: 0 });
    await expect(scanPendingNow()).resolves.toEqual({ queued: 4, alreadyQueued: 0 });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pending-automation/scan', {
      method: 'POST',
    });
  });
});
