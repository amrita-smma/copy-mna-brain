import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFn, findById, listRuns, enqueueAgentRun, createDbFn } = vi.hoisted(() => ({
  authFn: vi.fn(),
  findById: vi.fn(),
  listRuns: vi.fn(),
  enqueueAgentRun: vi.fn(),
  createDbFn: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authFn }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockRoutinesRepository {
    findById = findById;
    listRuns = listRuns;
  }
  return {
    ...actual,
    RoutinesRepository: MockRoutinesRepository,
  };
});
vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbFn }));

import { GET, POST } from './route';

function makeRequest(): never {
  return {} as never;
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const ROUTINE = {
  id: 'rt-1',
  title: 'Daily APAC scan',
  prompt: 'Scan APAC chemicals',
  agent_name: null,
  priority: 0,
  cron_expression: '0 6 * * *',
  timezone: 'UTC',
  schedule_kind: 'daily',
  schedule_spec: { time: '06:00' },
  next_fire_at: '2026-05-19T06:00:00.000Z',
  last_fired_at: null,
  enabled: true,
  archived_at: null,
};

describe('GET /api/routines/[id]/runs', () => {
  beforeEach(() => {
    authFn.mockReset();
    findById.mockReset();
    listRuns.mockReset();
    createDbFn.mockReset();
    createDbFn.mockReturnValue({});
  });

  it('returns 401 when unauthenticated', async () => {
    authFn.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when routine not found', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-1' } });
    findById.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), paramsOf('missing'));
    expect(res.status).toBe(404);
  });

  it('returns the run list', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-1' } });
    findById.mockResolvedValueOnce(ROUTINE);
    listRuns.mockResolvedValueOnce([{ id: 'q-1' }, { id: 'q-2' }]);
    const res = await GET(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: 'q-1' }, { id: 'q-2' }] });
  });
});

describe('POST /api/routines/[id]/runs (manual fire)', () => {
  beforeEach(() => {
    authFn.mockReset();
    findById.mockReset();
    enqueueAgentRun.mockReset();
    createDbFn.mockReset();
    createDbFn.mockReturnValue({});
  });

  it('returns 401 when unauthenticated', async () => {
    authFn.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(401);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('returns 404 when routine not found', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-1' } });
    findById.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), paramsOf('missing'));
    expect(res.status).toBe(404);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('enqueues with trigger_source=api, manual=true, and origin_routine_id', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce(ROUTINE);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });

    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-1', created: true });

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: 'analysis',
        triggerSource: 'api',
        originRoutineId: 'rt-1',
        triggeredByUserId: 'u-42',
        triggerMeta: expect.objectContaining({
          routine_id: 'rt-1',
          manual: true,
        }),
        input: expect.objectContaining({
          prompt: 'Scan APAC chemicals',
          instruction: 'Scan APAC chemicals',
          title: 'Daily APAC scan',
        }),
      }),
    );
  });

  it('does NOT pass an idempotency key (every click queues a new run)', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce(ROUTINE);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });

    await POST(makeRequest(), paramsOf('rt-1'));

    const call = enqueueAgentRun.mock.calls[0][1];
    expect(call.idempotencyKey).toBeUndefined();
  });

  it('uses the routine-supplied agent_name when present', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce({ ...ROUTINE, agent_name: 'lead_scan' });
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });

    await POST(makeRequest(), paramsOf('rt-1'));

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentName: 'lead_scan' }),
    );
  });

  it('returns 500 when enqueue throws', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce(ROUTINE);
    enqueueAgentRun.mockRejectedValueOnce(new Error('queue full'));

    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'queue full' });
  });
});
