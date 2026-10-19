import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrowMock,
  getPipelineHeadingMock,
  updatePipelineHeadingMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  getPipelineHeadingMock: vi.fn(),
  updatePipelineHeadingMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return {
    ...actual,
    getActiveWorkspaceId: getActiveWorkspaceIdMock,
    getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  };
});

import { GET, PUT } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import { WorkspaceNotFoundError } from '@/lib/services/workspaceService';

const USER_ID = 'user-1';
const WORKSPACE_ID = 'w1';

const DEFAULT_HEADING = {
  title: 'Deal Pipeline',
  subtitle: 'Track companies through all stages',
};

function makeRequest(body: unknown): never {
  return { json: async () => body } as never;
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: USER_ID } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getPipelineHeadingMock.mockReset();
  updatePipelineHeadingMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    workspaceService: {
      getPipelineHeading: getPipelineHeadingMock,
      updatePipelineHeading: updatePipelineHeadingMock,
    },
  });
});

describe('GET /api/pipeline-heading', () => {
  it('returns 401 without a session, without reading the workspace', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(getPipelineHeadingMock).not.toHaveBeenCalled();
  });

  it('returns the active workspace’s heading', async () => {
    getPipelineHeadingMock.mockResolvedValueOnce(DEFAULT_HEADING);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(getPipelineHeadingMock).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(await res.json()).toEqual({ data: DEFAULT_HEADING });
  });

  it('returns 500 when the service throws', async () => {
    getPipelineHeadingMock.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET();

    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });
});

describe('PUT /api/pipeline-heading', () => {
  it('returns 401 without a session, without writing', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await PUT(makeRequest({ title: 'Acquisitions' }));

    expect(res.status).toBe(401);
    expect(updatePipelineHeadingMock).not.toHaveBeenCalled();
  });

  it('saves the trimmed heading and returns the resolved values', async () => {
    const saved = { title: 'Acquisitions', subtitle: 'Live targets only' };
    updatePipelineHeadingMock.mockResolvedValueOnce(saved);

    const res = await PUT(
      makeRequest({ title: '  Acquisitions  ', subtitle: 'Live targets only' }),
    );

    expect(res.status).toBe(200);
    expect(updatePipelineHeadingMock).toHaveBeenCalledWith(WORKSPACE_ID, {
      title: 'Acquisitions',
      subtitle: 'Live targets only',
    });
    expect(await res.json()).toEqual({ data: saved });
  });

  it('passes a blank field through as null so it clears to the default', async () => {
    updatePipelineHeadingMock.mockResolvedValueOnce(DEFAULT_HEADING);

    const res = await PUT(makeRequest({ title: '', subtitle: '  ' }));

    expect(res.status).toBe(200);
    expect(updatePipelineHeadingMock).toHaveBeenCalledWith(WORKSPACE_ID, {
      title: null,
      subtitle: null,
    });
  });

  it('returns 400 on an invalid payload', async () => {
    const res = await PUT(makeRequest({ title: 42 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'title must be a string' });
    expect(updatePipelineHeadingMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an over-long title', async () => {
    const res = await PUT(makeRequest({ title: 'x'.repeat(81) }));

    expect(res.status).toBe(400);
    expect(updatePipelineHeadingMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the request has no active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());

    const res = await PUT(makeRequest({ title: 'Acquisitions' }));

    expect(res.status).toBe(403);
    expect(updatePipelineHeadingMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the workspace row is gone', async () => {
    updatePipelineHeadingMock.mockRejectedValueOnce(new WorkspaceNotFoundError(WORKSPACE_ID));

    const res = await PUT(makeRequest({ title: 'Acquisitions' }));

    expect(res.status).toBe(404);
  });
});
