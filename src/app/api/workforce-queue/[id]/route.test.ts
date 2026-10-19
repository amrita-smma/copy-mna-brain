import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  findByIdMock,
  findVersionForRunMock,
} = vi.hoisted(() => ({
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
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue(WORKSPACE_ID);
    findByIdMock.mockReset();
    findVersionForRunMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { findById: findByIdMock },
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
