import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, createContainerMock, getNavSummaryMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  getNavSummaryMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

describe('GET /api/workforce-queue/summary', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    getNavSummaryMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { getNavSummary: getNavSummaryMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getNavSummaryMock).not.toHaveBeenCalled();
  });

  it("returns the caller's nav summary", async () => {
    getNavSummaryMock.mockResolvedValueOnce({ unseen_failures: 2, queue: 3, running: 1 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { unseen_failures: 2, queue: 3, running: 1 } });
    expect(getNavSummaryMock).toHaveBeenCalledWith('u1');
  });

  it('returns 500 when the summary fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getNavSummaryMock.mockRejectedValueOnce(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
