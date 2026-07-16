import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  findByIdMock,
  cancelByIdMock,
  dispatcherTickMock,
  afterMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  findByIdMock: vi.fn(),
  cancelByIdMock: vi.fn(),
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
    cancelById = cancelByIdMock;
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

function makeRequest(body: unknown): never {
  return {
    text: async () =>
      body === undefined ? '' : JSON.stringify(body),
  } as never;
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    triggered_by_user_id: USER_ID,
    status: 'running',
    ...overrides,
  };
}

describe('POST /api/workforce-queue/[id]/cancel', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    findByIdMock.mockReset();
    cancelByIdMock.mockReset();
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({}), makeParams(ROW_ID));
    expect(res.status).toBe(401);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the row does not exist', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({}), makeParams(ROW_ID));
    expect(res.status).toBe(404);
    expect(cancelByIdMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the task creator', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'other-user' } });
    findByIdMock.mockResolvedValueOnce(makeRow());
    const res = await POST(makeRequest({}), makeParams(ROW_ID));
    expect(res.status).toBe(403);
    expect(cancelByIdMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the row is already terminal (cancelById returns null)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow({ status: 'succeeded' }));
    cancelByIdMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({}), makeParams(ROW_ID));
    expect(res.status).toBe(409);
  });

  it('cancels the row, returns it, and kicks the dispatcher on success', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow());
    const cancelledRow = {
      ...makeRow(),
      status: 'failed',
      error: { code: 'cancelled_by_user' },
    };
    cancelByIdMock.mockResolvedValueOnce(cancelledRow);

    const res = await POST(
      makeRequest({ reason: 'changed my mind' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ item: cancelledRow });

    expect(cancelByIdMock).toHaveBeenCalledWith(ROW_ID, {
      userId: USER_ID,
      reason: 'changed my mind',
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(dispatcherTickMock).toHaveBeenCalledTimes(1);
  });

  it('passes undefined reason when body is empty', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow());
    cancelByIdMock.mockResolvedValueOnce({ ...makeRow(), status: 'failed' });

    await POST(makeRequest(undefined), makeParams(ROW_ID));

    expect(cancelByIdMock).toHaveBeenCalledWith(ROW_ID, {
      userId: USER_ID,
      reason: undefined,
    });
  });

  it('allows cancel when the row has no triggered_by_user_id (system-spawned)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(
      makeRow({ triggered_by_user_id: null }),
    );
    cancelByIdMock.mockResolvedValueOnce({ ...makeRow(), status: 'failed' });

    const res = await POST(makeRequest({}), makeParams(ROW_ID));

    expect(res.status).toBe(200);
    expect(cancelByIdMock).toHaveBeenCalled();
  });
});
