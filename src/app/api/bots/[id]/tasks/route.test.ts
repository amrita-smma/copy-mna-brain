import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botTaskLogService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botTaskLogService: { list: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';
import { BotNotFoundError } from '@/lib/services/botService';

const params = { params: Promise.resolve({ id: 'b1' }) };

describe('GET /api/bots/[id]/tasks', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    botTaskLogService.list.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botTaskLogService });
  });

  it('reads a page of the task log for the caller, from the cursor', async () => {
    botTaskLogService.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    const res = await GET(new NextRequest('http://localhost/api/bots/b1/tasks?before=c1&limit=10'), params);
    expect(res.status).toBe(200);
    expect(botTaskLogService.list).toHaveBeenCalledWith('u1', 'b1', { before: 'c1', limit: 10 });
  });

  it('uses the default page size without a limit, and 404s a hidden bot', async () => {
    botTaskLogService.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    await GET(new NextRequest('http://localhost/api/bots/b1/tasks'), params);
    expect(botTaskLogService.list).toHaveBeenCalledWith('u1', 'b1', { before: undefined, limit: undefined });

    botTaskLogService.list.mockRejectedValueOnce(new BotNotFoundError());
    expect((await GET(new NextRequest('http://localhost/api/bots/b1/tasks'), params)).status).toBe(404);
  });
});
