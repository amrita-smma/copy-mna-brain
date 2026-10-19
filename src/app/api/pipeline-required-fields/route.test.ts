import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrowMock,
  getPipelineRequiredFieldsMock,
  updatePipelineRequiredFieldsMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  getPipelineRequiredFieldsMock: vi.fn(),
  updatePipelineRequiredFieldsMock: vi.fn(),
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

const WORKSPACE_ID = 'w1';
const ALL = ['name', 'entered_by', 'source', 'deal_type', 'geography', 'segment', 'banker'];

function makeRequest(body: unknown): never {
  return { json: async () => body } as never;
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getPipelineRequiredFieldsMock.mockReset().mockResolvedValue(ALL);
  updatePipelineRequiredFieldsMock.mockReset().mockImplementation(async (_id, keys) => keys);
  createContainerMock.mockReset().mockReturnValue({
    workspaceService: {
      getPipelineRequiredFields: getPipelineRequiredFieldsMock,
      updatePipelineRequiredFields: updatePipelineRequiredFieldsMock,
    },
  });
});

describe('GET /api/pipeline-required-fields', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the active workspace configuration', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ALL });
    expect(getPipelineRequiredFieldsMock).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

describe('PUT /api/pipeline-required-fields', () => {
  it('saves the validated keys, keeping the company name', async () => {
    const res = await PUT(makeRequest({ requiredFields: ['geography'] }));
    expect(res.status).toBe(200);
    expect(updatePipelineRequiredFieldsMock).toHaveBeenCalledWith(WORKSPACE_ID, ['name', 'geography']);
    expect(await res.json()).toEqual({ data: ['name', 'geography'] });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await PUT(makeRequest({ requiredFields: [] }));
    expect(res.status).toBe(401);
    expect(updatePipelineRequiredFieldsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown key without saving', async () => {
    const res = await PUT(makeRequest({ requiredFields: ['revenue'] }));
    expect(res.status).toBe(400);
    expect(updatePipelineRequiredFieldsMock).not.toHaveBeenCalled();
  });

  it('returns 403 without an active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    const res = await PUT(makeRequest({ requiredFields: [] }));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the workspace no longer exists', async () => {
    updatePipelineRequiredFieldsMock.mockRejectedValueOnce(new WorkspaceNotFoundError(WORKSPACE_ID));
    const res = await PUT(makeRequest({ requiredFields: [] }));
    expect(res.status).toBe(404);
  });
});
