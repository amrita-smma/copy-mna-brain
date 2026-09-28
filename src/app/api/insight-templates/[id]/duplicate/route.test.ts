import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, isWorkspaceAdminMock, duplicateTemplateMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  isWorkspaceAdminMock: vi.fn(),
  duplicateTemplateMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1') }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';

const TEMPLATE_ID = 'tpl-source-1';
const post = () =>
  POST(new NextRequest(`http://localhost/api/insight-templates/${TEMPLATE_ID}/duplicate`, { method: 'POST' }), {
    params: Promise.resolve({ id: TEMPLATE_ID }),
  });

describe('POST /api/insight-templates/[id]/duplicate', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    isWorkspaceAdminMock.mockReset().mockResolvedValue(false);
    duplicateTemplateMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isWorkspaceAdmin: isWorkspaceAdminMock },
      insightTemplateService: { duplicate: duplicateTemplateMock },
    });
  });

  it('returns 401 when no session is present', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await post();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(duplicateTemplateMock).not.toHaveBeenCalled();
  });

  it('returns 201 with duplicated template for a non-admin member, without an admin check', async () => {
    const duplicated = { id: 'tpl-dup-1', name: 'Market Brief (copy)' };
    duplicateTemplateMock.mockResolvedValueOnce(duplicated);

    const res = await post();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: duplicated });
    expect(duplicateTemplateMock).toHaveBeenCalledWith(TEMPLATE_ID, 'user-1');
    expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
  });
});
