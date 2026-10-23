import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  getForUser: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));

import { GET } from './route';

describe('GET /api/crm/suggested-questions', () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    mocks.createDb.mockReset().mockReturnValue({ db: true });
    mocks.getActiveWorkspaceId.mockReset().mockResolvedValue('w1');
    mocks.getForUser.mockReset();
    mocks.createContainer.mockReset().mockReturnValue({
      crmSuggestedQuestionService: { getForUser: mocks.getForUser },
    });
  });

  it("returns the session user's questions in the active workspace", async () => {
    const data = { personalized: [], generic: [], hasSync: false, stale: false };
    mocks.getForUser.mockResolvedValueOnce(data);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(mocks.createContainer).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(mocks.getForUser).toHaveBeenCalledWith('u1');
  });

  it('returns 401 without a session user', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mocks.getForUser).not.toHaveBeenCalled();
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getForUser.mockRejectedValueOnce(new Error('boom'));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
