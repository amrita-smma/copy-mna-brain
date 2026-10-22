import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botService: { get: vi.fn(), update: vi.fn(), archive: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { DELETE, GET, PATCH } from './route';
import { BotForbiddenError, BotNotFoundError } from '@/lib/services/botService';

const URL = 'http://localhost/api/bots/b1';
const params = { params: Promise.resolve({ id: 'b1' }) };

describe('/api/bots/[id]', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    for (const fn of Object.values(botService)) fn.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botService });
  });

  it('GET returns the bot', async () => {
    botService.get.mockResolvedValueOnce({ id: 'b1' });
    const res = await GET(new NextRequest(URL), params);
    expect(res.status).toBe(200);
    expect(botService.get).toHaveBeenCalledWith('u1', 'b1');
  });

  it('GET maps a hidden or missing bot to 404', async () => {
    botService.get.mockRejectedValueOnce(new BotNotFoundError());
    expect((await GET(new NextRequest(URL), params)).status).toBe(404);
  });

  it('PATCH passes the body to the service as the caller', async () => {
    botService.update.mockResolvedValueOnce({ id: 'b1', name: 'New' });
    const res = await PATCH(
      new NextRequest(URL, { method: 'PATCH', body: JSON.stringify({ name: 'New' }) }),
      params,
    );
    expect(res.status).toBe(200);
    expect(botService.update).toHaveBeenCalledWith('u1', 'b1', { name: 'New' });
  });

  it("PATCH maps editing someone else's bot to 403", async () => {
    botService.update.mockRejectedValueOnce(new BotForbiddenError());
    const res = await PATCH(
      new NextRequest(URL, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
      params,
    );
    expect(res.status).toBe(403);
  });

  it('DELETE archives the bot', async () => {
    const res = await DELETE(new NextRequest(URL, { method: 'DELETE' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'b1' } });
    expect(botService.archive).toHaveBeenCalledWith('u1', 'b1');
  });

});
