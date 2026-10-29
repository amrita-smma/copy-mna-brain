import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, listHistoryMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  listHistoryMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { InvalidHistoryCursorError } from '@/lib/services/aiWorkforceService';
import { GET } from './route';

function call(query = '') {
  return GET(new NextRequest(`http://localhost/api/workforce-queue/history${query}`));
}

describe('GET /api/workforce-queue/history', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    listHistoryMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { listHistory: listHistoryMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(listHistoryMock).not.toHaveBeenCalled();
  });

  it('passes the cursor, search and limit through and returns the page', async () => {
    const page = { items: [{ id: 'r1' }], next_cursor: 'next' };
    listHistoryMock.mockResolvedValueOnce(page);

    const res = await call('?cursor=abc&q=deck&limit=10');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: page });
    expect(listHistoryMock).toHaveBeenCalledWith({ cursor: 'abc', search: 'deck', limit: 10 });
  });

  it('leaves the page size to the service when no limit is given', async () => {
    listHistoryMock.mockResolvedValueOnce({ items: [], next_cursor: null });
    await call();
    expect(listHistoryMock).toHaveBeenCalledWith({ cursor: null, search: null, limit: undefined });
  });

  it('returns 400 for a non-numeric limit', async () => {
    const res = await call('?limit=lots');
    expect(res.status).toBe(400);
    expect(listHistoryMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a cursor the service rejects', async () => {
    listHistoryMock.mockRejectedValueOnce(new InvalidHistoryCursorError());
    const res = await call('?cursor=bogus');
    expect(res.status).toBe(400);
  });

  it('returns 500 when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listHistoryMock.mockRejectedValueOnce(new Error('db down'));
    const res = await call();
    expect(res.status).toBe(500);
  });
});
