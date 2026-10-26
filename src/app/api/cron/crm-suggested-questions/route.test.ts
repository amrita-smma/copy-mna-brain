import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  listWorkspaces: vi.fn(),
  runDaily: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { GET } from './route';

const URL = 'http://localhost/api/cron/crm-suggested-questions';

function daily(over: Record<string, unknown> = {}) {
  return { forDate: '2026-10-18', members: 1, generated: 1, reconciled: 0, emailLinked: 0, reconcileFailed: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  mocks.createContainer.mockReturnValue({
    workspaceService: { listWorkspaces: mocks.listWorkspaces },
    crmSuggestedQuestionService: { runDaily: mocks.runDaily },
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/crm-suggested-questions', () => {
  it('returns 401 without the cron secret when one is set', async () => {
    process.env.CRON_SECRET = 's3cret';

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
  });

  it("runs every live workspace with its own container and totals the rows and links", async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.runDaily
      .mockResolvedValueOnce(daily({ members: 3, generated: 2, reconciled: 2, emailLinked: 4 }))
      .mockResolvedValueOnce(daily({ reconciled: 1, emailLinked: 1 }));

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      forDate: '2026-10-18',
      workspaces: 2,
      generated: 3,
      reconciled: 3,
      emailLinked: 5,
    });
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-2');
    expect(mocks.runDaily).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one workspace fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.runDaily.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(daily());

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      forDate: '2026-10-18',
      workspaces: 2,
      generated: 1,
      reconciled: 0,
      emailLinked: 0,
      failedWorkspaces: ['ws-1'],
    });
  });

  it('reports a workspace whose link reconcile failed', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.runDaily
      .mockResolvedValueOnce(daily({ reconcileFailed: true }))
      .mockResolvedValueOnce(daily({ reconciled: 1 }));

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      forDate: '2026-10-18',
      workspaces: 2,
      generated: 2,
      reconciled: 1,
      emailLinked: 0,
      reconcileFailedWorkspaces: ['ws-1'],
    });
  });
});
