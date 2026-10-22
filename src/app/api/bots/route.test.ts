import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botService: { list: vi.fn(), create: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';
import { BotValidationError } from '@/lib/services/botService';

const URL = 'http://localhost/api/bots';
const post = (body: unknown) =>
  POST(new NextRequest(URL, { method: 'POST', body: JSON.stringify(body) }));

describe('/api/bots', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    botService.list.mockReset();
    botService.create.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botService });
  });

  describe('GET', () => {
    it("returns the caller's visible bots", async () => {
      botService.list.mockResolvedValueOnce([{ id: 'b1' }]);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [{ id: 'b1' }] });
      expect(createContainerMock).toHaveBeenCalledWith({}, 'ws-1');
      expect(botService.list).toHaveBeenCalledWith('u1');
    });


    it('401s without a session', async () => {
      authMock.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
    });
  });

  describe('POST', () => {
    it('creates a bot owned by the caller', async () => {
      botService.create.mockResolvedValueOnce({ id: 'b2' });

      const res = await post({ name: 'Scout' });

      expect(res.status).toBe(201);
      expect(botService.create).toHaveBeenCalledWith('u1', { name: 'Scout' });
    });

    it('maps a validation error to 400', async () => {
      botService.create.mockRejectedValueOnce(new BotValidationError('Name is required'));

      const res = await post({ name: '' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Name is required' });
    });

    it('rejects a non-object body', async () => {
      const res = await post(['x']);
      expect(res.status).toBe(400);
      expect(botService.create).not.toHaveBeenCalled();
    });
  });
});
