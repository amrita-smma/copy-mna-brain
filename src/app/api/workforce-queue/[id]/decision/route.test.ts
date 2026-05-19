import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  findByIdMock,
  appendDecisionMock,
  markResumeReadyMock,
  dispatcherTickMock,
  afterMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  findByIdMock: vi.fn(),
  appendDecisionMock: vi.fn(),
  markResumeReadyMock: vi.fn(),
  dispatcherTickMock: vi.fn(),
  // Capture-then-run so we can assert the callback was scheduled AND
  // that it actually invokes the dispatcher.
  afterMock: vi.fn((cb: () => Promise<void>) => {
    void cb();
  }),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workforce', () => ({ dispatcherTick: dispatcherTickMock }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    appendDecision = appendDecisionMock;
    markResumeReady = markResumeReadyMock;
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
    json: async () => body,
  } as never;
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    triggered_by_user_id: USER_ID,
    status: 'waiting_for_human_input',
    ...overrides,
  };
}

describe('POST /api/workforce-queue/[id]/decision — auth & validation', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { findById: findByIdMock },
    });
    findByIdMock.mockReset();
    appendDecisionMock.mockReset();
    markResumeReadyMock.mockReset();
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({ tool_call_id: 'c1', tool_name: 't', decision: 'approve' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(401);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });

    const res = await POST(
      makeRequest({ tool_call_id: '', tool_name: 't', decision: 'approve' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tool_call_id is required/);
  });

  it('returns 400 when decision is neither approve nor reject', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });

    const res = await POST(
      makeRequest({
        tool_call_id: 'c1',
        tool_name: 't',
        decision: 'maybe',
      }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 when the row does not exist', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({ tool_call_id: 'c1', tool_name: 't', decision: 'approve' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the task creator', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'other-user' } });
    findByIdMock.mockResolvedValueOnce(makeRow());

    const res = await POST(
      makeRequest({ tool_call_id: 'c1', tool_name: 't', decision: 'approve' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(403);
    expect(appendDecisionMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the row is not waiting_for_human_input', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow({ status: 'running' }));

    const res = await POST(
      makeRequest({ tool_call_id: 'c1', tool_name: 't', decision: 'approve' }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/status 'running'/);
  });
});

describe('POST /api/workforce-queue/[id]/decision — approve flow', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { findById: findByIdMock },
    });
    findByIdMock.mockReset();
    appendDecisionMock.mockReset().mockResolvedValue({});
    markResumeReadyMock.mockReset().mockResolvedValue({});
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('appends an approve decision, queues the resume payload, and kicks the dispatcher', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow());

    const res = await POST(
      makeRequest({
        tool_call_id: 'call-42',
        tool_name: 'promote_l0_to_l1',
        decision: 'approve',
      }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'queued_for_resume' });

    // Audit entry — shape must include tool_call_id, tool_name, decision, decided_at
    expect(appendDecisionMock).toHaveBeenCalledTimes(1);
    expect(appendDecisionMock).toHaveBeenCalledWith(
      ROW_ID,
      expect.objectContaining({
        tool_call_id: 'call-42',
        tool_name: 'promote_l0_to_l1',
        decision: 'approve',
        decided_at: expect.any(String),
      }),
    );

    // Resume payload is JSON-encoded into resume_token via markResumeReady.
    expect(markResumeReadyMock).toHaveBeenCalledTimes(1);
    const [calledRowId, reason, payloadJson] =
      markResumeReadyMock.mock.calls[0];
    expect(calledRowId).toBe(ROW_ID);
    expect(reason).toBe('human approve');
    expect(JSON.parse(payloadJson as string)).toEqual({
      decisions: [{ type: 'approve' }],
    });

    // Reactive dispatcher kick scheduled via after().
    expect(afterMock).toHaveBeenCalledTimes(1);
    // afterMock invokes the callback synchronously in this test harness, so
    // by the time we get here dispatcherTick has been awaited.
    expect(dispatcherTickMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/workforce-queue/[id]/decision — reject flow', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { findById: findByIdMock },
    });
    findByIdMock.mockReset();
    appendDecisionMock.mockReset().mockResolvedValue({});
    markResumeReadyMock.mockReset().mockResolvedValue({});
    dispatcherTickMock.mockReset().mockResolvedValue({ outcome: 'empty' });
    afterMock.mockClear();
  });

  it('carries the rejection_message into both the audit entry and the resume payload', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow());

    const res = await POST(
      makeRequest({
        tool_call_id: 'call-99',
        tool_name: 'promote_l0_to_l1',
        decision: 'reject',
        rejection_message: 'wrong company, try again',
      }),
      makeParams(ROW_ID),
    );

    expect(res.status).toBe(200);
    expect(appendDecisionMock).toHaveBeenCalledWith(
      ROW_ID,
      expect.objectContaining({
        decision: 'reject',
        rejection_message: 'wrong company, try again',
      }),
    );
    const payloadJson = markResumeReadyMock.mock.calls[0][2];
    expect(JSON.parse(payloadJson as string)).toEqual({
      decisions: [
        { type: 'reject', message: 'wrong company, try again' },
      ],
    });
  });

  it('drops a blank rejection_message from the audit entry', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    findByIdMock.mockResolvedValueOnce(makeRow());

    await POST(
      makeRequest({
        tool_call_id: 'call-99',
        tool_name: 'promote_l0_to_l1',
        decision: 'reject',
        rejection_message: '   ',
      }),
      makeParams(ROW_ID),
    );

    const auditEntry = appendDecisionMock.mock.calls[0][1];
    expect(auditEntry).not.toHaveProperty('rejection_message');
  });
});
