import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, markReadMock, markUnreadMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  markReadMock: vi.fn(),
  markUnreadMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { DELETE, POST } from './route';
import { BotNotFoundError } from '@/lib/services/botService';

const req = () => new NextRequest('http://localhost/api/bots/b1/read', { method: 'POST' });
const params = { params: Promise.resolve({ id: 'b1' }) };

describe('POST /api/bots/[id]/read', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    markReadMock.mockReset().mockResolvedValue(undefined);
    markUnreadMock.mockReset().mockResolvedValue(undefined);
    createContainerMock
      .mockReset()
      .mockReturnValue({ botService: { markRead: markReadMock, markUnread: markUnreadMock } });
  });

  it("marks the caller's thread with the bot read", async () => {
    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(markReadMock).toHaveBeenCalledWith('u1', 'b1');
  });

  it('404s for a bot the caller cannot see', async () => {
    markReadMock.mockRejectedValueOnce(new BotNotFoundError());
    expect((await POST(req(), params)).status).toBe(404);
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(markReadMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/bots/[id]/read', () => {
  const del = () => new NextRequest('http://localhost/api/bots/b1/read', { method: 'DELETE' });

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    markUnreadMock.mockReset().mockResolvedValue(undefined);
    createContainerMock.mockReset().mockReturnValue({ botService: { markUnread: markUnreadMock } });
  });

  it("marks the caller's thread with the bot unread", async () => {
    const res = await DELETE(del(), params);

    expect(res.status).toBe(200);
    expect(markUnreadMock).toHaveBeenCalledWith('u1', 'b1');
  });

  it('404s for a bot the caller cannot see', async () => {
    markUnreadMock.mockRejectedValueOnce(new BotNotFoundError());
    expect((await DELETE(del(), params)).status).toBe(404);
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await DELETE(del(), params)).status).toBe(401);
    expect(markUnreadMock).not.toHaveBeenCalled();
  });
});
