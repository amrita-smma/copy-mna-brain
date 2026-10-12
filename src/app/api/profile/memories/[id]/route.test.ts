import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  forget: vi.fn(),
  userMemoryService: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services', () => ({ createContainer: mocks.createContainer }));

import { DELETE } from './route';

const req = () => new NextRequest('http://localhost/api/profile/memories/m1');
const params = (id = 'm1') => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.forget.mockResolvedValue(true);
  mocks.userMemoryService.mockReturnValue({ forget: mocks.forget });
  mocks.createContainer.mockReturnValue({ userMemoryService: mocks.userMemoryService });
});

describe('DELETE /api/profile/memories/:id', () => {
  it('forgets the memory for the session user', async () => {
    const res = await DELETE(req(), params());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { id: 'm1' } });
    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
    expect(mocks.forget).toHaveBeenCalledWith('m1');
  });

  it('404s on another member’s memory rather than revealing that it exists', async () => {
    mocks.forget.mockResolvedValue(false);

    const res = await DELETE(req(), params('someone-elses-id'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Memory not found' });
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await DELETE(req(), params())).status).toBe(401);
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it('500s on an unexpected failure', async () => {
    mocks.forget.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await DELETE(req(), params())).status).toBe(500);

    spy.mockRestore();
  });
});
