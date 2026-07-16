import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  submitUserMessageMock,
  dispatcherTickMock,
  afterMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  submitUserMessageMock: vi.fn(),
  dispatcherTickMock: vi.fn(),
  afterMock: vi.fn((cb: () => Promise<void>) => {
    void cb();
  }),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock, withBackgroundDb: vi.fn(async (cb) => cb(createDbMock())) }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workforce', () => ({ dispatcherTick: dispatcherTickMock }));
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>(
    'next/server',
  );
  return { ...actual, after: afterMock };
});

import { POST } from './route';
import {
  TaskBusyError,
  TaskNotFoundError,
  TaskOwnershipError,
} from '@/lib/services/aiWorkforceService';

const ROW_ID = 'row-1';
const USER_ID = 'user-1';

function makeRequest(body: unknown): never {
  return {
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as never;
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/workforce-queue/[id]/message', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { submitUserMessage: submitUserMessageMock },
    });
    submitUserMessageMock.mockReset();
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({ text: 'hi' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(401);
    expect(submitUserMessageMock).not.toHaveBeenCalled();
  });

  it('returns 400 when text is missing', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({}), makeParams(ROW_ID));
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is empty after trim', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(
      makeRequest({ text: '   \n  ' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when text exceeds the length cap', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(
      makeRequest({ text: 'a'.repeat(4001) }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 with kind=attached and kicks the dispatcher', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockResolvedValueOnce({
      kind: 'attached',
      message_id: 'm-1',
      queue_position: 2,
      status: 'waiting_for_human_input',
    });

    const res = await POST(
      makeRequest({ text: 'add Acme' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: {
        kind: 'attached',
        message_id: 'm-1',
        queue_position: 2,
        status: 'waiting_for_human_input',
      },
    });
    expect(submitUserMessageMock).toHaveBeenCalledWith({
      runId: ROW_ID,
      userId: USER_ID,
      text: 'add Acme',
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(dispatcherTickMock).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with kind=forked when the service forks a follow-up run', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockResolvedValueOnce({
      kind: 'forked',
      new_run_id: 'new-run',
      status: 'pending',
    });

    const res = await POST(
      makeRequest({ text: 'follow up' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.kind).toBe('forked');
    expect(body.data.new_run_id).toBe('new-run');
  });

  it('returns 404 on TaskNotFoundError', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockRejectedValueOnce(new TaskNotFoundError(ROW_ID));

    const res = await POST(
      makeRequest({ text: 'hi' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 on TaskOwnershipError', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockRejectedValueOnce(new TaskOwnershipError());

    const res = await POST(
      makeRequest({ text: 'hi' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(403);
  });

  it('returns 409 on TaskBusyError', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockRejectedValueOnce(new TaskBusyError('running'));

    const res = await POST(
      makeRequest({ text: 'hi' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(409);
  });

  it('returns 500 on an unexpected error', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitUserMessageMock.mockRejectedValueOnce(new Error('db unreachable'));
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const res = await POST(
      makeRequest({ text: 'hi' }),
      makeParams(ROW_ID),
    );
    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});
