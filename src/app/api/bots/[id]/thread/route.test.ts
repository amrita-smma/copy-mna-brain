import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, openThreadMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  openThreadMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { BotNotFoundError } from '@/lib/services/botService';

const req = () => new NextRequest('http://localhost/api/bots/b1/thread', { method: 'POST' });
const params = { params: Promise.resolve({ id: 'b1' }) };

describe('POST /api/bots/[id]/thread', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    openThreadMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botService: { openThread: openThreadMock } });
  });

  it("returns the id of the caller's permanent thread with the bot", async () => {
    openThreadMock.mockResolvedValueOnce({ bot: { id: 'b1' }, chat: { id: 'chat-1' } });

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { chatId: 'chat-1' } });
    expect(openThreadMock).toHaveBeenCalledWith('u1', 'b1');
  });

  it('404s for a bot the caller cannot see', async () => {
    openThreadMock.mockRejectedValueOnce(new BotNotFoundError());
    expect((await POST(req(), params)).status).toBe(404);
  });
});
