import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({ db: true })) }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { cronUnauthorized, sweepWorkspaces } from './cron';

const URL = 'http://localhost/api/cron/some-sweep';

beforeEach(() => {
  delete process.env.CRON_SECRET;
  mocks.listWorkspaces.mockReset();
  mocks.createContainer
    .mockReset()
    .mockReturnValue({ workspaceService: { listWorkspaces: mocks.listWorkspaces } });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

describe('cronUnauthorized', () => {
  it('lets every request through while CRON_SECRET is unset', () => {
    expect(cronUnauthorized(new NextRequest(URL))).toBeNull();
  });

  it('returns a 401 without the bearer secret and null with it', async () => {
    process.env.CRON_SECRET = 's3cret';

    const res = cronUnauthorized(
      new NextRequest(URL, { headers: { authorization: 'Bearer wrong' } }),
    );
    expect(res?.status).toBe(401);
    await expect(res?.json()).resolves.toEqual({ error: 'Unauthorized' });

    expect(
      cronUnauthorized(new NextRequest(URL, { headers: { authorization: 'Bearer s3cret' } })),
    ).toBeNull();
  });
});

describe('sweepWorkspaces', () => {
  it('runs every workspace in turn and records the ones that fail without stopping', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listWorkspaces.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }]);
    const fn = vi.fn(async (workspaceId: string) => {
      if (workspaceId === 'ws-2') throw new Error('boom');
    });

    const result = await sweepWorkspaces('cron/test', fn);

    expect(result).toEqual({ workspaces: 3, failedWorkspaces: ['ws-2'] });
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(fn).toHaveBeenCalledWith('ws-1', { db: true });
    expect(console.error).toHaveBeenCalledWith(
      '[cron/test] workspace ws-2 failed:',
      expect.any(Error),
    );
  });

  it('throws when the workspaces cannot be listed', async () => {
    mocks.listWorkspaces.mockRejectedValue(new Error('db down'));
    const fn = vi.fn();

    await expect(sweepWorkspaces('cron/test', fn)).rejects.toThrow('db down');
    expect(fn).not.toHaveBeenCalled();
  });
});
