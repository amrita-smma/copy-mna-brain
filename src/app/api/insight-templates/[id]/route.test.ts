import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, isWorkspaceAdminMock, service } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  isWorkspaceAdminMock: vi.fn(),
  service: { update: vi.fn(), delete: vi.fn(), deletePermanently: vi.fn(), getHtml: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET, PATCH, DELETE } from './route';
import { InsightTemplateNotFoundError } from '@/lib/services/insightTemplateService';

const TEMPLATE_ID = 'tpl-test-1';
const call = (handler: typeof GET, method = 'GET', body?: unknown, search = '') =>
  handler(
    new NextRequest(`http://localhost/api/insight-templates/${TEMPLATE_ID}${search}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: TEMPLATE_ID }) },
  );

describe('/api/insight-templates/[id] routes', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    isWorkspaceAdminMock.mockReset().mockResolvedValue(false);
    for (const fn of Object.values(service)) fn.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isWorkspaceAdmin: isWorkspaceAdminMock },
      insightTemplateService: service,
    });
  });

  describe('GET /api/insight-templates/[id]', () => {
    it('returns 200 with the template html, without requiring admin rights', async () => {
      service.getHtml.mockResolvedValueOnce('<h1>Market Brief</h1>');

      const res = await call(GET);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { html: '<h1>Market Brief</h1>' } });
      expect(service.getHtml).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
    });

    it('returns 404 when the template is missing or not previewable (e.g. a legacy PDF/DOCX row)', async () => {
      service.getHtml.mockRejectedValueOnce(new InsightTemplateNotFoundError());

      const res = await call(GET);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Insight template not found' });
    });
  });

  describe.each([
    ['PATCH', PATCH, { name: 'Updated' }, service.update],
    ['DELETE', DELETE, undefined, service.delete],
  ] as const)('%s /api/insight-templates/[id] auth', (method, handler, body, serviceFn) => {
    it('returns 401 when no session is present', async () => {
      authMock.mockResolvedValueOnce(null);

      const res = await call(handler, method, body);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(serviceFn).not.toHaveBeenCalled();
    });

    it('lets a non-admin member through without an admin check', async () => {
      const res = await call(handler, method, body);

      expect(res.status).toBe(200);
      expect(serviceFn).toHaveBeenCalled();
      expect(isWorkspaceAdminMock).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/insight-templates/[id]', () => {
    it('returns 200 with updated template', async () => {
      const patch = { name: 'Updated Name', description: 'New Description', icon: 'scale' };
      service.update.mockResolvedValueOnce({ id: TEMPLATE_ID, ...patch });

      const res = await call(PATCH, 'PATCH', patch);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: TEMPLATE_ID, ...patch } });
      expect(service.update).toHaveBeenCalledWith(TEMPLATE_ID, patch);
    });
  });

  describe('DELETE /api/insight-templates/[id]', () => {
    it('soft-deletes by default and returns 200 with id', async () => {
      service.delete.mockResolvedValueOnce({ id: TEMPLATE_ID });

      const res = await call(DELETE, 'DELETE');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: TEMPLATE_ID } });
      expect(service.delete).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(service.deletePermanently).not.toHaveBeenCalled();
    });

    it('hard-deletes with ?permanent=true', async () => {
      service.deletePermanently.mockResolvedValueOnce({ id: TEMPLATE_ID });

      const res = await call(DELETE, 'DELETE', undefined, '?permanent=true');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: TEMPLATE_ID } });
      expect(service.deletePermanently).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(service.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the template is missing or already deleted', async () => {
      service.delete.mockRejectedValueOnce(new InsightTemplateNotFoundError());

      const res = await call(DELETE, 'DELETE');

      expect(res.status).toBe(404);
    });
  });
});
