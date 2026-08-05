import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, createDbMock, getActiveWorkspaceIdMock, dispatchMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    dispatchMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services', () => ({
  createContainer: () => ({
    fundAiOpinionService: { dispatch: dispatchMock },
  }),
}));

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/funds/ai-opinion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/funds/ai-opinion', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    dispatchMock.mockReset().mockResolvedValue({ runId: 'run-1' });
  });

  it('returns 401 when there is no session user', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ fundAssetId: 'asset-1' }) as never);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when fundAssetId is missing', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    const res = await POST(makeRequest({}) as never);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing required field: fundAssetId',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dispatches and returns 202 with runId', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    const res = await POST(makeRequest({ fundAssetId: 'asset-1' }) as never);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ data: { runId: 'run-1' } });
    expect(dispatchMock).toHaveBeenCalledWith('asset-1', 'user-1');
  });

  it('returns 404 when the fund asset does not exist', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dispatchMock.mockRejectedValueOnce(
      new Error('No fund asset found for id "missing"'),
    );
    const res = await POST(makeRequest({ fundAssetId: 'missing' }) as never);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'No fund asset found for id "missing"',
    });
  });

  it('returns 500 with a generic message when dispatch throws unexpectedly', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dispatchMock.mockRejectedValueOnce(new Error('queue unavailable'));
    const res = await POST(makeRequest({ fundAssetId: 'asset-1' }) as never);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });
});
