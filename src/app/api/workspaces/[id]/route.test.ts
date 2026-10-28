import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, softDeleteWorkspaceMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  softDeleteWorkspaceMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { DELETE, PATCH } from './route';
import { NotSuperadminError, WorkspaceNotFoundError } from '@/lib/services/workspaceService';

const USER_ID = 'user-1';
const WORKSPACE_ID = 'w1';

function makeRequest(): never {
  return {} as never;
}

const params = { params: Promise.resolve({ id: WORKSPACE_ID }) };

describe('DELETE /api/workspaces/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    softDeleteWorkspaceMock.mockReset();
    createContainerMock
      .mockReset()
      .mockReturnValue({ workspaceService: { softDeleteWorkspace: softDeleteWorkspaceMock } });
  });

  it('returns 401 without a session, without touching the workspace', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await DELETE(makeRequest(), params);

    expect(res.status).toBe(401);
    expect(softDeleteWorkspaceMock).not.toHaveBeenCalled();
  });

  it('archives the workspace and returns the updated row', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const archived = { id: WORKSPACE_ID, name: 'W1', slug: 'w1', deleted_at: '2026-09-15T00:00:00.000Z' };
    softDeleteWorkspaceMock.mockResolvedValueOnce(archived);

    const res = await DELETE(makeRequest(), params);

    expect(res.status).toBe(200);
    expect(softDeleteWorkspaceMock).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
    expect(await res.json()).toEqual({ data: archived });
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    softDeleteWorkspaceMock.mockRejectedValueOnce(new NotSuperadminError());

    const res = await DELETE(makeRequest(), params);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 404 for an unknown workspace id', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    softDeleteWorkspaceMock.mockRejectedValueOnce(new WorkspaceNotFoundError('nope'));

    const res = await DELETE(makeRequest(), params);

    expect(res.status).toBe(404);
  });

  it('returns 500 when the service fails unexpectedly', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    softDeleteWorkspaceMock.mockRejectedValueOnce(new Error('db down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(makeRequest(), params);

    expect(res.status).toBe(500);
    consoleError.mockRestore();
  });
});

describe('PATCH /api/workspaces/[id] — pptx_template', () => {
  const isSuperadminMock = vi.fn();
  const updatePptxTemplateMock = vi.fn();
  const patch = (body: unknown) => PATCH({ json: async () => body } as never, params);

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: USER_ID } });
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    updatePptxTemplateMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: {
        isSuperadmin: isSuperadminMock,
        updatePptxTemplate: updatePptxTemplateMock,
      },
    });
  });

  it('sets the workspace PowerPoint template', async () => {
    const row = { id: WORKSPACE_ID, pptx_template: 'starcapital' };
    updatePptxTemplateMock.mockResolvedValueOnce(row);

    const res = await patch({ pptx_template: 'starcapital' });

    expect(res.status).toBe(200);
    expect(updatePptxTemplateMock).toHaveBeenCalledWith(WORKSPACE_ID, 'starcapital');
    expect(await res.json()).toEqual({ data: row });
  });

  it('rejects an unknown template without writing', async () => {
    const res = await patch({ pptx_template: 'mckinsey' });

    expect(res.status).toBe(400);
    expect(updatePptxTemplateMock).not.toHaveBeenCalled();
  });

  it('is superadmin-only', async () => {
    isSuperadminMock.mockResolvedValueOnce(false);

    const res = await patch({ pptx_template: 'starcapital' });

    expect(res.status).toBe(403);
    expect(updatePptxTemplateMock).not.toHaveBeenCalled();
  });
});
