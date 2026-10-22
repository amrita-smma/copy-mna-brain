import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botMemoryService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botMemoryService: { list: vi.fn(), replace: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, PUT } from './route';
import { BotNotFoundError, BotValidationError } from '@/lib/services/botService';

const URL = 'http://localhost/api/bots/b1/memory';
const params = { params: Promise.resolve({ id: 'b1' }) };
const notes = [{ text: 'Answer in Bahasa', created_at: 't' }];

describe('/api/bots/[id]/memory', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    botMemoryService.list.mockReset();
    botMemoryService.replace.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botMemoryService });
  });

  it('GET returns the caller\'s notes on the bot', async () => {
    botMemoryService.list.mockResolvedValueOnce(notes);
    const res = await GET(new NextRequest(URL), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { bot_id: 'b1', notes } });
    expect(botMemoryService.list).toHaveBeenCalledWith('u1', 'b1');
  });

  it('GET is 401 signed out and 404 for a bot the caller cannot see', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest(URL), params)).status).toBe(401);
    botMemoryService.list.mockRejectedValueOnce(new BotNotFoundError());
    expect((await GET(new NextRequest(URL), params)).status).toBe(404);
  });

  it('PUT replaces the notes as the caller and returns the list', async () => {
    botMemoryService.replace.mockResolvedValueOnce(notes);
    const res = await PUT(new NextRequest(URL, { method: 'PUT', body: JSON.stringify({ notes: ['Answer in Bahasa'] }) }), params);
    expect(res.status).toBe(200);
    expect(botMemoryService.replace).toHaveBeenCalledWith('u1', 'b1', ['Answer in Bahasa']);
  });

  it('PUT answers 400 for a non-object body and for a validation error', async () => {
    expect((await PUT(new NextRequest(URL, { method: 'PUT', body: '[]' }), params)).status).toBe(400);
    botMemoryService.replace.mockRejectedValueOnce(new BotValidationError('A note cannot be blank'));
    const res = await PUT(new NextRequest(URL, { method: 'PUT', body: JSON.stringify({ notes: [''] }) }), params);
    expect(res.status).toBe(400);
  });
});
