import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  isWorkspaceAdminMock,
  listMock,
  listDeletedMock,
  createMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  isWorkspaceAdminMock: vi.fn(),
  listMock: vi.fn(),
  listDeletedMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';
import { InsightTemplateTooLargeError } from '@/lib/services/insightTemplateService';

const URL = 'http://localhost/api/insight-templates';
const BODY = { name: 'Template Name', icon: 'scale', html: '<h1>Template</h1>' };
const post = () =>
  POST(new NextRequest(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY) }));

describe('/api/insight-templates routes', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-test-1');
    isWorkspaceAdminMock.mockReset().mockResolvedValue(false);
    listMock.mockReset();
    listDeletedMock.mockReset();
    createMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isWorkspaceAdmin: isWorkspaceAdminMock },
      insightTemplateService: { list: listMock, listDeleted: listDeletedMock, create: createMock },
    });
  });

  describe('GET /api/insight-templates', () => {
    it('returns template list without requiring admin rights', async () => {
      const templates = [{ id: 'tpl-1' }, { id: 'tpl-2' }];
      listMock.mockResolvedValueOnce(templates);

      const res = await GET(new NextRequest(URL));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: templates });
      expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
      expect(listDeletedMock).not.toHaveBeenCalled();
    });

    it('lists Recently deleted for ?deleted=true', async () => {
      const deleted = [{ id: 'tpl-9', deleted_at: '2026-09-24T00:00:00Z' }];
      listDeletedMock.mockResolvedValueOnce(deleted);

      const res = await GET(new NextRequest(`${URL}?deleted=true`));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: deleted });
      expect(listMock).not.toHaveBeenCalled();
    });

    it('returns empty array when no active workspace', async () => {
      getActiveWorkspaceIdMock.mockResolvedValueOnce(null);

      const res = await GET(new NextRequest(URL));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    });
  });

  describe('POST /api/insight-templates', () => {
    it('returns 401 when no session is present', async () => {
      authMock.mockResolvedValueOnce(null);

      const res = await post();

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(createMock).not.toHaveBeenCalled();
    });

    it('returns 201 with created template, icon passed through, for a non-admin member without an admin check', async () => {
      const created = { id: 'tpl-1', name: 'Template Name' };
      createMock.mockResolvedValueOnce(created);

      const res = await post();

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ data: created });
      expect(createMock).toHaveBeenCalledWith({ ...BODY, description: undefined, userId: 'user-1' });
      expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
    });

    it('maps an oversized template to 413 with the size message', async () => {
      createMock.mockRejectedValueOnce(new InsightTemplateTooLargeError(285_000));

      const res = await post();

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: 'Template is 285,000 characters; templates are limited to 250,000.',
      });
    });
  });
});
