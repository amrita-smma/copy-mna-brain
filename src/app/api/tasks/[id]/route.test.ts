import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { UserTaskValidationError } from '@/lib/services/userTaskService';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  getActiveWorkspaceIdOrThrow: vi.fn(),
  createContainer: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => {
  class NoActiveWorkspaceError extends Error {}
  return {
    NoActiveWorkspaceError,
    getActiveWorkspaceId: mocks.getActiveWorkspaceId,
    getActiveWorkspaceIdOrThrow: mocks.getActiveWorkspaceIdOrThrow,
  };
});
vi.mock('@/lib/services', () => ({ createContainer: mocks.createContainer }));
vi.mock('@/lib/queue', () => ({ enqueueSendEmail: vi.fn() }));

import { DELETE, PATCH } from './route';

const URL = 'http://localhost/api/tasks/t1';
const ctx = { params: Promise.resolve({ id: 't1' }) };
const patch = (body: unknown) =>
  new NextRequest(URL, { method: 'PATCH', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.getActiveWorkspaceIdOrThrow.mockResolvedValue('ws-1');
  mocks.createContainer.mockReturnValue({
    userTaskService: { update: mocks.update, delete: mocks.remove },
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('updates the session user’s task', async () => {
    mocks.update.mockResolvedValue({ id: 't1', completedAt: '2026-10-15T00:00:00.000Z' });

    const res = await PATCH(patch({ completed: true }), ctx);

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('user-1', 't1', {
      title: undefined,
      remindAt: undefined,
      completed: true,
    });
  });

  it('returns 404 when the task is not the user’s', async () => {
    mocks.update.mockResolvedValue(null);

    const res = await PATCH(patch({ title: 'x' }), ctx);

    expect(res.status).toBe(404);
  });

  it('returns 403 when the workspace does not resolve', async () => {
    mocks.getActiveWorkspaceIdOrThrow.mockRejectedValue(new NoActiveWorkspaceError());

    const res = await PATCH(patch({ title: 'x' }), ctx);

    expect(res.status).toBe(403);
  });

  it('maps a validation error to 400', async () => {
    mocks.update.mockRejectedValue(new UserTaskValidationError('nothing to update'));

    const res = await PATCH(patch({}), ctx);

    expect(res.status).toBe(400);
  });

  it('returns 401 without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    const res = await PATCH(patch({ title: 'x' }), ctx);

    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('deletes the session user’s task', async () => {
    mocks.remove.mockResolvedValue(true);

    const res = await DELETE(new NextRequest(URL, { method: 'DELETE' }), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { id: 't1' } });
    expect(mocks.remove).toHaveBeenCalledWith('user-1', 't1');
  });

  it('returns 404 when nothing was deleted', async () => {
    mocks.remove.mockResolvedValue(false);

    const res = await DELETE(new NextRequest(URL, { method: 'DELETE' }), ctx);

    expect(res.status).toBe(404);
  });
});
