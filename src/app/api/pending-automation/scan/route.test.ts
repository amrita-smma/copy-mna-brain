import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdOrThrowMock,
  scanNowMock,
  previewScanNowMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  scanNowMock: vi.fn(),
  previewScanNowMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return { ...actual, getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock };
});

import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const PREVIEW = {
  tracks: [{ id: 't1', title: 'Healthcare' }],
  companies: [{ trackIds: ['t1'], hasCard: false }],
};

const post = (body?: string) =>
  new NextRequest('http://localhost/api/pending-automation/scan', { method: 'POST', body });

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('w1');
  scanNowMock.mockReset().mockResolvedValue({ queued: 7, alreadyQueued: 1 });
  previewScanNowMock.mockReset().mockResolvedValue(PREVIEW);
  createContainerMock.mockReset().mockReturnValue({
    pendingAutoScanService: { scanNow: scanNowMock, previewScanNow: previewScanNowMock },
  });
});

describe('GET /api/pending-automation/scan', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(previewScanNowMock).not.toHaveBeenCalled();
  });

  it('returns the Scan now preview for the active workspace', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PREVIEW });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(previewScanNowMock).toHaveBeenCalled();
  });

  it('returns 403 without an active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe('POST /api/pending-automation/scan', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(scanNowMock).not.toHaveBeenCalled();
  });

  it('queues a screening task per pending company as the signed-in user', async () => {
    const res = await POST(post());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { queued: 7, alreadyQueued: 1 } });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(scanNowMock).toHaveBeenCalledWith('user-1', null);
  });

  it('passes a track selection through to the service', async () => {
    const res = await POST(post(JSON.stringify({ trackIds: ['t1', 't1'], includeUnmatched: true })));
    expect(res.status).toBe(202);
    expect(scanNowMock).toHaveBeenCalledWith('user-1', { trackIds: ['t1'], includeUnmatched: true });
  });

  it('returns 400 for an invalid selection without scanning', async () => {
    const res = await POST(post(JSON.stringify({ trackIds: 't1' })));
    expect(res.status).toBe(400);
    expect(scanNowMock).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await POST(post('{'));
    expect(res.status).toBe(400);
    expect(scanNowMock).not.toHaveBeenCalled();
  });

  it('returns 403 without an active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    const res = await POST(post());
    expect(res.status).toBe(403);
  });
});
