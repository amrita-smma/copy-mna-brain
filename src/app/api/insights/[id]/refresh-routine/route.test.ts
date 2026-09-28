import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RoutineInsightNotFoundError } from '@/lib/services/routineService';

const { authMock, createContainerMock, getActiveForInsightMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveForInsightMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace')>()),
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1'),
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

const INSIGHT_ID = 'insight-test-1';
const call = () =>
  GET(new NextRequest(`http://localhost/api/insights/${INSIGHT_ID}/refresh-routine`), {
    params: Promise.resolve({ id: INSIGHT_ID }),
  });

describe('GET /api/insights/[id]/refresh-routine', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    getActiveForInsightMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      routineService: { getActiveForInsight: getActiveForInsightMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['{ data: null } when no active routine exists', null],
    ['{ data: row } when active routine exists', { id: 'rt-1', insight_id: INSIGHT_ID, enabled: true }],
  ])('returns 200 with %s', async (_label, routine) => {
    getActiveForInsightMock.mockResolvedValueOnce(routine);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: routine });
    expect(getActiveForInsightMock).toHaveBeenCalledWith(INSIGHT_ID);
  });

  it('returns 404 on RoutineInsightNotFoundError', async () => {
    getActiveForInsightMock.mockRejectedValueOnce(new RoutineInsightNotFoundError('Insight not found in workspace'));

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Insight not found in workspace' });
  });
});
