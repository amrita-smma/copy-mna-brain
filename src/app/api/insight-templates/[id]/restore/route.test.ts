import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, service } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  service: { restore: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { InsightTemplateNotFoundError } from '@/lib/services/insightTemplateService';

const post = () =>
  POST(new NextRequest('http://localhost/api/insight-templates/tpl-1/restore', { method: 'POST' }), {
    params: Promise.resolve({ id: 'tpl-1' }),
  });

describe('POST /api/insight-templates/[id]/restore', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    service.restore.mockReset();
    createContainerMock.mockReset().mockReturnValue({ insightTemplateService: service });
  });

  it('returns 401 when no session is present', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await post();

    expect(res.status).toBe(401);
    expect(service.restore).not.toHaveBeenCalled();
  });

  it('restores the template and returns 200', async () => {
    const row = { id: 'tpl-1', deleted_at: null };
    service.restore.mockResolvedValueOnce(row);

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: row });
    expect(service.restore).toHaveBeenCalledWith('tpl-1');
  });

  it('returns 404 when no deleted template matches', async () => {
    service.restore.mockRejectedValueOnce(new InsightTemplateNotFoundError());

    const res = await post();

    expect(res.status).toBe(404);
  });
});
