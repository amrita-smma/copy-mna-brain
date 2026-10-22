import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botService: { setPinned: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { PUT } from './route';
import { BotValidationError } from '@/lib/services/botService';

const put = (body: string) =>
  PUT(new NextRequest('http://localhost/api/bots/pins', { method: 'PUT', body }));

describe('PUT /api/bots/pins', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    botService.setPinned.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botService });
  });

  it("saves the caller's pinned bots and returns the reordered list", async () => {
    botService.setPinned.mockResolvedValueOnce([{ id: 'b2' }, { id: 'b1' }]);

    const res = await put(JSON.stringify({ bot_ids: ['b2', 'b1'] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'b2' }, { id: 'b1' }] });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'ws-1');
    expect(botService.setPinned).toHaveBeenCalledWith('u1', ['b2', 'b1']);
  });

  it('400s on a body that is not a JSON object', async () => {
    expect((await put('not json')).status).toBe(400);
    expect((await put('[]')).status).toBe(400);
    expect(botService.setPinned).not.toHaveBeenCalled();
  });

  it('400s when the service rejects the order', async () => {
    botService.setPinned.mockRejectedValueOnce(new BotValidationError('Pinned bots must be a list of bot ids'));
    expect((await put(JSON.stringify({ bot_ids: 'b1' }))).status).toBe(400);
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await put(JSON.stringify({ bot_ids: [] }))).status).toBe(401);
  });
});
