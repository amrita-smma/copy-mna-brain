import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, getActiveWorkspaceIdOrThrowMock, scanNowMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdOrThrowMock: vi.fn(),
    scanNowMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return { ...actual, getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock };
});

import { POST } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('w1');
  scanNowMock.mockReset().mockResolvedValue({ queued: 7, alreadyQueued: 1 });
  createContainerMock.mockReset().mockReturnValue({
    pendingAutoScanService: { scanNow: scanNowMock },
  });
});

describe('POST /api/pending-automation/scan', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(scanNowMock).not.toHaveBeenCalled();
  });

  it('queues a screening task per pending company as the signed-in user', async () => {
    const res = await POST();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { queued: 7, alreadyQueued: 1 } });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(scanNowMock).toHaveBeenCalledWith('user-1');
  });

  it('returns 403 without an active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    const res = await POST();
    expect(res.status).toBe(403);
  });
});
