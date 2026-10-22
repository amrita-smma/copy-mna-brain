import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFn, findById, listRuns, insightFindById, enqueueAgentRun, createDbFn } = vi.hoisted(() => ({
  authFn: vi.fn(),
  findById: vi.fn(),
  listRuns: vi.fn(),
  insightFindById: vi.fn(),
  enqueueAgentRun: vi.fn(),
  createDbFn: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authFn }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockRoutinesRepository {
    findWorkforceRoutineById = findById;
    listRuns = listRuns;
  }
  return {
    ...actual,
    RoutinesRepository: MockRoutinesRepository,
  };
});
vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbFn }));
vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>();
  return {
    ...actual,
    getActiveWorkspaceId: vi.fn().mockResolvedValue('ws-1'),
    getActiveWorkspaceIdOrThrow: vi.fn().mockResolvedValue('ws-1'),
  };
});
// The real RoutineService over the mocked repositories, so the route's
// refusal and agent resolution run the production code.
vi.mock('@/lib/services/container', async () => {
  const { RoutineService } = await import('@/lib/services/routineService');
  const repos = await import('@/lib/repositories');
  return {
    createContainer: (db: never, workspaceId: string) => ({
      routineService: new RoutineService(
        new repos.RoutinesRepository(db, workspaceId),
        { findById: insightFindById } as never,
        workspaceId,
      ),
    }),
  };
});

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
  insight_id: null,
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
    insightFindById.mockReset();
    insightFindById.mockResolvedValue(undefined);
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

    expect(insightFindById).not.toHaveBeenCalled();
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

  it('returns 500 without echoing the cause when enqueue throws', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce(ROUTINE);
    enqueueAgentRun.mockRejectedValueOnce(new Error('queue full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });

  it('refuses (409, with the reason) a routine paused because its agent was deprecated, and queues nothing', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce({
      ...ROUTINE,
      insight_id: 'ins-77',
      enabled: false,
      paused_reason: 'agent_deprecated',
    });
    insightFindById.mockResolvedValue({ id: 'ins-77', name: 'Market Map', agent_key: 'bangun' });

    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Paused — @bangun was deprecated. Rebind the insight to resume.',
      pausedReason: 'agent_deprecated',
    });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('still force-runs a manually paused routine', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce({ ...ROUTINE, enabled: false, paused_reason: null });
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });

    const res = await POST(makeRequest(), paramsOf('rt-1'));
    expect(res.status).toBe(201);
  });

  it('insight routine force-run carries insight_id + manual: true in trigger_meta and the bound agent', async () => {
    authFn.mockResolvedValueOnce({ user: { id: 'u-42' } });
    findById.mockResolvedValueOnce({ ...ROUTINE, insight_id: 'ins-77' });
    insightFindById.mockResolvedValue({ id: 'ins-77', name: 'Coal', agent_key: 'minerba' });
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-99', created: true });

    const res = await POST(makeRequest(), paramsOf('rt-1'));

    expect(res.status).toBe(201);
    expect(insightFindById).toHaveBeenCalledWith('ins-77', 'ws-1');
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        triggerMeta: expect.objectContaining({ routine_id: 'rt-1', manual: true, insight_id: 'ins-77' }),
        input: expect.objectContaining({ insight_id: 'ins-77', agent_key: 'minerba' }),
      }),
    );
  });
});
