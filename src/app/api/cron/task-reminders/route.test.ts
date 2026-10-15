import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  listWorkspaces: vi.fn(),
  processDueReminders: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/services', () => ({ createContainer: mocks.createContainer }));

import { GET } from './route';

const URL = 'http://localhost/api/cron/task-reminders';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  mocks.createContainer.mockReturnValue({
    workspaceService: { listWorkspaces: mocks.listWorkspaces },
    userTaskService: { processDueReminders: mocks.processDueReminders },
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/task-reminders', () => {
  it('rejects a request without the cron secret', async () => {
    process.env.CRON_SECRET = 's3cret';

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
  });

  it('sweeps every workspace and totals the emails sent', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.processDueReminders
      .mockResolvedValueOnce({ reminded: 2, notified: 2 })
      .mockResolvedValueOnce({ reminded: 1, notified: 1 });

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({ ok: true, workspaces: 2, notified: 3 });
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-2');
  });

  it('keeps sweeping when one workspace fails', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    mocks.processDueReminders
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ reminded: 1, notified: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      workspaces: 2,
      notified: 1,
      failedWorkspaces: ['ws-1'],
    });
  });
});
