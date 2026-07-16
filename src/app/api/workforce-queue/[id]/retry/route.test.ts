import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  findByIdMock,
  retryByIdMock,
  dispatcherTickMock,
  afterMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  findByIdMock: vi.fn(),
  retryByIdMock: vi.fn(),
  dispatcherTickMock: vi.fn(),
  afterMock: vi.fn((cb: () => Promise<void>) => {
    void cb();
  }),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock, withBackgroundDb: vi.fn(async (cb) => cb(createDbMock())) }));
vi.mock('@/lib/workforce', () => ({ dispatcherTick: dispatcherTickMock }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    findById = findByIdMock;
    retryById = retryByIdMock;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>(
    'next/server',
  );
  return { ...actual, after: afterMock };
});

import { POST } from './route';

const ROW_ID = 'row-1';
const USER_ID = 'user-1';

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    triggered_by_user_id: USER_ID,
    status: 'failed',
    ...overrides,
  };
}

describe('POST /api/workforce-queue/[id]/retry', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    findByIdMock.mockReset();
    retryByIdMock.mockReset();
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST({} as never, makeParams(ROW_ID));
    expect(res.status).toBe(401);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the row does not exist', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(null);
    const res = await POST({} as never, makeParams(ROW_ID));
    expect(res.status).toBe(404);
    expect(retryByIdMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the task creator', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'other-user' } });
    findByIdMock.mockResolvedValueOnce(makeRow());
    const res = await POST({} as never, makeParams(ROW_ID));
    expect(res.status).toBe(403);
    expect(retryByIdMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'succeeded', 'waiting_for_human_input'])(
    'returns 409 when the row is in non-retryable status %s',
    async (status) => {
      authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
      findByIdMock.mockResolvedValueOnce(makeRow({ status }));
      const res = await POST({} as never, makeParams(ROW_ID));
      expect(res.status).toBe(409);
      expect(retryByIdMock).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'rejected', 'timed_out'])(
    'enqueues a retry for terminal-failure status %s and kicks the dispatcher',
    async (status) => {
      authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
      findByIdMock.mockResolvedValueOnce(makeRow({ status }));
      const fresh = { id: 'new-row', status: 'pending', retried_from_id: ROW_ID };
      retryByIdMock.mockResolvedValueOnce(fresh);

      const res = await POST({} as never, makeParams(ROW_ID));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ item: fresh });
      expect(retryByIdMock).toHaveBeenCalledWith(ROW_ID, { userId: USER_ID });
      expect(afterMock).toHaveBeenCalledTimes(1);
      expect(dispatcherTickMock).toHaveBeenCalledTimes(1);
    },
  );

  it('allows retry when the row has no triggered_by_user_id (system-spawned)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(
      makeRow({ triggered_by_user_id: null }),
    );
    retryByIdMock.mockResolvedValueOnce({ id: 'new-row' });

    const res = await POST({} as never, makeParams(ROW_ID));

    expect(res.status).toBe(200);
    expect(retryByIdMock).toHaveBeenCalled();
  });
});
