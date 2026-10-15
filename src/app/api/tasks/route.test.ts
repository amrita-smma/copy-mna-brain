import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { UserTaskValidationError } from '@/lib/services/userTaskService';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  getActiveWorkspaceIdOrThrow: vi.fn(),
  createContainer: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
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

import { GET, POST } from './route';

const URL = 'http://localhost/api/tasks';
const post = (body: unknown) =>
  new NextRequest(URL, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.getActiveWorkspaceIdOrThrow.mockResolvedValue('ws-1');
  mocks.createContainer.mockReturnValue({
    userTaskService: { list: mocks.list, create: mocks.create },
  });
});

describe('GET /api/tasks', () => {
  it('serves the session user’s tasks from the active workspace', async () => {
    mocks.list.mockResolvedValue([{ id: 't1', title: 'Call banker' }]);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: [{ id: 't1', title: 'Call banker' }] });
    expect(mocks.createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(mocks.list).toHaveBeenCalledWith('user-1');
  });

  it('returns 401 without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns an empty list when there is no active workspace', async () => {
    mocks.getActiveWorkspaceId.mockResolvedValue(null);

    const res = await GET();

    await expect(res.json()).resolves.toEqual({ data: [] });
  });
});

describe('POST /api/tasks', () => {
  it('creates a task for the session user and returns 201', async () => {
    mocks.create.mockResolvedValue({ id: 't1', title: 'Call banker' });

    const res = await POST(post({ title: 'Call banker', remindAt: '2026-10-16T02:00:00.000Z' }));

    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith('user-1', {
      title: 'Call banker',
      remindAt: '2026-10-16T02:00:00.000Z',
    });
  });

  it('returns 403 when the workspace does not resolve', async () => {
    mocks.getActiveWorkspaceIdOrThrow.mockRejectedValue(new NoActiveWorkspaceError());

    const res = await POST(post({ title: 'x' }));

    expect(res.status).toBe(403);
  });

  it('maps a validation error to 400', async () => {
    mocks.create.mockRejectedValue(new UserTaskValidationError('title is required'));

    const res = await POST(post({ title: '' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'title is required' });
  });

  it('rejects a non-JSON body', async () => {
    const res = await POST(new NextRequest(URL, { method: 'POST', body: 'nope' }));

    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
