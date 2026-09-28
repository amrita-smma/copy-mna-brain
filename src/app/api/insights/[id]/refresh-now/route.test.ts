import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import {
  RoutineAgentPausedError,
  RoutineInsightNotFoundError,
} from '@/lib/services/routineService';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdOrThrowMock,
  runInsightRefreshNowMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  runInsightRefreshNowMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>();
  return {
    ...actual,
    getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  };
});
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const INSIGHT_ID = '99999999-8888-4777-8666-555555555555';

function call(id = INSIGHT_ID) {
  return POST(new NextRequest(`http://localhost/api/insights/${id}/refresh-now`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

describe('POST /api/insights/[id]/refresh-now', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
    runInsightRefreshNowMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      routineService: { runInsightRefreshNow: runInsightRefreshNowMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(runInsightRefreshNowMock).not.toHaveBeenCalled();
  });

  it('queues a refresh as the signed-in user and answers 201 with the run', async () => {
    runInsightRefreshNowMock.mockResolvedValueOnce({ runId: 'run-1', created: true, routineId: null });

    const res = await call();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { runId: 'run-1', created: true, routineId: null } });
    expect(createContainerMock).toHaveBeenCalledWith({}, WORKSPACE_ID);
    expect(runInsightRefreshNowMock).toHaveBeenCalledWith(INSIGHT_ID, 'u1');
  });

  it('answers 200 with created: false when a refresh is already live', async () => {
    runInsightRefreshNowMock.mockResolvedValueOnce({ runId: 'run-live', created: false, routineId: 'rt-1' });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data.created).toBe(false);
  });

  it('404s a non-UUID id without touching the service', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(404);
    expect(runInsightRefreshNowMock).not.toHaveBeenCalled();
  });

  it('maps a missing insight to 404 and a paused binding to 409 with the reason', async () => {
    runInsightRefreshNowMock.mockRejectedValueOnce(new RoutineInsightNotFoundError('Insight not found'));
    expect((await call()).status).toBe(404);

    runInsightRefreshNowMock.mockRejectedValueOnce(
      new RoutineAgentPausedError('agent_deprecated', 'Paused — @bangun was deprecated. Rebind the insight to resume.'),
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Paused — @bangun was deprecated. Rebind the insight to resume.',
      pausedReason: 'agent_deprecated',
    });
  });

  it('answers 403 without an active workspace and 500 without echoing an unexpected error', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    expect((await call()).status).toBe(403);

    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    runInsightRefreshNowMock.mockRejectedValueOnce(new Error('db exploded'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
