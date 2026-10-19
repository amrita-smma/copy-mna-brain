import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  findByIdMock,
  findVersionForRunMock,
  markFailureSeenMock,
} = vi.hoisted(() => ({
  markFailureSeenMock: vi.fn(),
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  findByIdMock: vi.fn(),
  findVersionForRunMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

const WORKSPACE_ID = 'ws-1';
const RUN_ID = 'run-1';

function call() {
  const req = new NextRequest(`http://localhost/api/workforce-queue/${RUN_ID}`);
  return GET(req, { params: Promise.resolve({ id: RUN_ID }) });
}

describe('GET /api/workforce-queue/[id]', () => {
  it("marks a failed run's failure as seen by the viewer", async () => {
    const item = { id: RUN_ID, workspace_id: WORKSPACE_ID, status: 'failed' };
    findByIdMock.mockResolvedValueOnce(item);
    findVersionForRunMock.mockResolvedValueOnce(null);

    const res = await call();

    expect(res.status).toBe(200);
    expect(markFailureSeenMock).toHaveBeenCalledWith(item, 'u1');
  });

  it('does not mark anything seen for a run in another workspace', async () => {
    findByIdMock.mockResolvedValueOnce({ id: RUN_ID, workspace_id: 'other', status: 'failed' });

    const res = await call();

    expect(res.status).toBe(404);
    expect(markFailureSeenMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue(WORKSPACE_ID);
    findByIdMock.mockReset();
    findVersionForRunMock.mockReset();
    markFailureSeenMock.mockReset().mockResolvedValue(false);
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { findById: findByIdMock, markFailureSeen: markFailureSeenMock },
      insightService: { findVersionForRun: findVersionForRunMock },
    });
  });

  it('returns the item with the insight version the run produced', async () => {
    const item = { id: RUN_ID, workspace_id: WORKSPACE_ID, status: 'succeeded' };
    const link = {
      insight_id: 'insight-1',
      insight_name: 'Q3 Trends',
      version_no: 4,
      is_unchanged: false,
    };
    findByIdMock.mockResolvedValueOnce(item);
    findVersionForRunMock.mockResolvedValueOnce(link);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ item, insight_version: link });
    expect(findVersionForRunMock).toHaveBeenCalledTimes(1);
    expect(findVersionForRunMock).toHaveBeenCalledWith(WORKSPACE_ID, RUN_ID);
  });

  it('404s a cross-workspace run without looking up its version', async () => {
    findByIdMock.mockResolvedValueOnce({ id: RUN_ID, workspace_id: 'ws-other' });

    const res = await call();

    expect(res.status).toBe(404);
    expect(findVersionForRunMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(401);
  });
});
