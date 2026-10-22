import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, botRoutineService } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  botRoutineService: { list: vi.fn(), create: vi.fn(), update: vi.fn(), archive: vi.fn(), runNow: vi.fn() },
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';
import { DELETE, PATCH } from './[routineId]/route';
import { POST as RUN } from './[routineId]/run/route';
import { BotRoutineNotFoundError, BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { BotForbiddenError } from '@/lib/services/botService';

const URL = 'http://localhost/api/bots/b1/routines';
const params = { params: Promise.resolve({ id: 'b1' }) };
const routineParams = { params: Promise.resolve({ id: 'b1', routineId: 'r1' }) };
const body = { title: 'Daily', prompt: 'Summarise', schedule_kind: 'daily', schedule_spec: { time: '09:00' }, timezone: 'UTC' };

describe('/api/bots/[id]/routines', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    for (const fn of Object.values(botRoutineService)) fn.mockReset();
    createContainerMock.mockReset().mockReturnValue({ botRoutineService });
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest(URL), params)).status).toBe(401);
  });

  it("GET lists the bot's routines for the caller", async () => {
    botRoutineService.list.mockResolvedValueOnce([{ id: 'r1' }]);
    const res = await GET(new NextRequest(URL), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'r1' }] });
    expect(botRoutineService.list).toHaveBeenCalledWith('u1', 'b1');
  });

  it('POST creates the routine as the caller, and maps a bad schedule to 400', async () => {
    botRoutineService.create.mockResolvedValueOnce({ id: 'r1' });
    const res = await POST(new NextRequest(URL, { method: 'POST', body: JSON.stringify(body) }), params);
    expect(res.status).toBe(201);
    expect(botRoutineService.create).toHaveBeenCalledWith('u1', 'b1', body);

    botRoutineService.create.mockRejectedValueOnce(new BotRoutineValidationError('Invalid time'));
    expect((await POST(new NextRequest(URL, { method: 'POST', body: JSON.stringify(body) }), params)).status).toBe(400);
    expect((await POST(new NextRequest(URL, { method: 'POST', body: '[]' }), params)).status).toBe(400);
  });

  it('PATCH updates, and maps a routine of another bot to 404 and a private bot to 403', async () => {
    botRoutineService.update.mockResolvedValueOnce({ id: 'r1' });
    const patch = (b: unknown) =>
      PATCH(new NextRequest(`${URL}/r1`, { method: 'PATCH', body: JSON.stringify(b) }), routineParams);
    expect((await patch({ enabled: false })).status).toBe(200);
    expect(botRoutineService.update).toHaveBeenCalledWith('u1', 'b1', 'r1', { enabled: false });

    botRoutineService.update.mockRejectedValueOnce(new BotRoutineNotFoundError());
    expect((await patch({ enabled: false })).status).toBe(404);
    botRoutineService.update.mockRejectedValueOnce(new BotForbiddenError());
    expect((await patch({ enabled: false })).status).toBe(403);
  });

  it('DELETE archives the routine', async () => {
    const res = await DELETE(new NextRequest(`${URL}/r1`, { method: 'DELETE' }), routineParams);
    expect(res.status).toBe(200);
    expect(botRoutineService.archive).toHaveBeenCalledWith('u1', 'b1', 'r1');
  });

  it('run sends the routine now, as the caller', async () => {
    const res = await RUN(new NextRequest(`${URL}/r1/run`, { method: 'POST' }), routineParams);
    expect(res.status).toBe(202);
    expect(botRoutineService.runNow).toHaveBeenCalledWith('u1', 'b1', 'r1');
  });
});
