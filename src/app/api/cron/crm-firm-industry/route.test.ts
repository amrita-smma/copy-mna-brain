import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  listWorkspaces: vi.fn(),
  classifyUnlabelledFirms: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { GET } from './route';

const URL = 'http://localhost/api/cron/crm-firm-industry';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  mocks.createContainer.mockReturnValue({
    workspaceService: { listWorkspaces: mocks.listWorkspaces },
    firmIndustryService: { classifyUnlabelledFirms: mocks.classifyUnlabelledFirms },
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/crm-firm-industry', () => {
  it('returns 401 without the cron secret when one is set', async () => {
    process.env.CRON_SECRET = 's3cret';

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
  });

  it('sweeps every live workspace with its own container and totals the claimed firms', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.classifyUnlabelledFirms
      .mockResolvedValueOnce({ claimed: 3, jobId: 'j1' })
      .mockResolvedValueOnce({ claimed: 1, jobId: 'j2' });

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({ ok: true, workspaces: 2, claimed: 4 });
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-2');
  });

  it('keeps going when one workspace fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.classifyUnlabelledFirms.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ claimed: 2, jobId: 'j' });

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      workspaces: 2,
      claimed: 2,
      failedWorkspaces: ['ws-1'],
    });
  });
});
