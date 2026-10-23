import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  listWorkspaces: vi.fn(),
  enrichNewTwoWayContacts: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { GET } from './route';

const URL = 'http://localhost/api/cron/crm-auto-enrich';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  mocks.createContainer.mockReturnValue({
    workspaceService: { listWorkspaces: mocks.listWorkspaces },
    crmContactEnrichmentService: { enrichNewTwoWayContacts: mocks.enrichNewTwoWayContacts },
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/crm-auto-enrich', () => {
  it('returns 401 without the cron secret when one is set', async () => {
    process.env.CRON_SECRET = 's3cret';

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
  });

  it('sweeps every live workspace with its own container and totals the queued runs', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.enrichNewTwoWayContacts.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({ ok: true, workspaces: 2, queued: 4 });
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-2');
  });

  it('keeps going when one workspace fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.enrichNewTwoWayContacts.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(2);

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      workspaces: 2,
      queued: 2,
      failedWorkspaces: ['ws-1'],
    });
  });
});
