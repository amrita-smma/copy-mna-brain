import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  setPrioritiesMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  setPrioritiesMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    setPriorities = setPrioritiesMock;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

import { POST } from './route';

const USER_ID = 'user-1';

function makeRequest(body: unknown): never {
  return {
    json: async () => body,
  } as never;
}

describe('POST /api/workforce-queue/reorder — auth & validation', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    setPrioritiesMock.mockReset().mockResolvedValue(undefined);
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ order: [{ id: 'r1', priority: 1 }] }),
    );
    expect(res.status).toBe(401);
    expect(setPrioritiesMock).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not an object', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it('returns 400 when order is missing or not an array', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ order: 'oops' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/order must be an array/);
  });

  it('returns 400 when an order item has a non-string id', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(
      makeRequest({ order: [{ id: 42, priority: 1 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when priority is not an integer', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(
      makeRequest({ order: [{ id: 'r1', priority: 1.5 }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/finite integer/);
  });

  it('returns 400 when an id is duplicated in the order', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(
      makeRequest({
        order: [
          { id: 'r1', priority: 2 },
          { id: 'r1', priority: 1 },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/duplicate id/);
  });

  it('returns 400 when more than the max number of rows are sent', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const huge = Array.from({ length: 201 }, (_, i) => ({
      id: `r${i}`,
      priority: 201 - i,
    }));
    const res = await POST(makeRequest({ order: huge }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/workforce-queue/reorder — happy path', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    setPrioritiesMock.mockReset().mockResolvedValue(undefined);
  });

  it('writes the priorities through to setPriorities and returns ok + count', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const order = [
      { id: 'r-top', priority: 3 },
      { id: 'r-mid', priority: 2 },
      { id: 'r-bot', priority: 1 },
    ];

    const res = await POST(makeRequest({ order }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, updated: 3 });
    expect(setPrioritiesMock).toHaveBeenCalledTimes(1);
    expect(setPrioritiesMock).toHaveBeenCalledWith(order);
  });

  it('accepts an empty order array (no-op)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ order: [] }));
    expect(res.status).toBe(200);
    expect(setPrioritiesMock).toHaveBeenCalledWith([]);
  });

  it('returns 500 when setPriorities throws', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    setPrioritiesMock.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(
      makeRequest({ order: [{ id: 'r1', priority: 1 }] }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('db down');
  });
});
