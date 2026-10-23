import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  createContainer: vi.fn(),
  refreshTouchedOverviews: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { POST } from './route';
import { InvalidOverviewRefreshSinceError } from '@/lib/services/contactConversationService';

const W1 = '00000000-0000-0000-0000-000000000001';
const W2 = '00000000-0000-0000-0000-000000000002';

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/auth/crm-overviews/refresh', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/auth/crm-overviews/refresh', () => {
  beforeEach(() => {
    mocks.createDb.mockReset().mockReturnValue({ db: true });
    mocks.refreshTouchedOverviews
      .mockReset()
      .mockResolvedValue({ candidates: 2, claimed: 1, jobId: 'job-1' });
    mocks.createContainer.mockReset().mockReturnValue({
      contactConversationService: { refreshTouchedOverviews: mocks.refreshTouchedOverviews },
    });
  });

  it('refreshes each workspace once, scoped to that workspace', async () => {
    const res = await post({ workspaceIds: [W1, W2, W1], since: '2026-10-21T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { workspaceId: W1, candidates: 2, claimed: 1, jobId: 'job-1' },
        { workspaceId: W2, candidates: 2, claimed: 1, jobId: 'job-1' },
      ],
    });
    expect(mocks.createContainer.mock.calls.map((c) => c[1])).toEqual([W1, W2]);
    expect(mocks.refreshTouchedOverviews).toHaveBeenCalledWith('2026-10-21T00:00:00Z');
  });

  it('returns 400 without valid workspace ids or since', async () => {
    expect((await post({ since: '2026-10-21T00:00:00Z' })).status).toBe(400);
    expect((await post({ workspaceIds: ['not-a-uuid'], since: '2026-10-21T00:00:00Z' })).status).toBe(400);
    expect((await post({ workspaceIds: [W1] })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect(mocks.refreshTouchedOverviews).not.toHaveBeenCalled();
  });

  it('returns 400 for an unparseable since', async () => {
    mocks.refreshTouchedOverviews.mockRejectedValueOnce(new InvalidOverviewRefreshSinceError('x'));
    expect((await post({ workspaceIds: [W1], since: 'x' })).status).toBe(400);
  });

  it('returns 500 on an unexpected error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.refreshTouchedOverviews.mockRejectedValueOnce(new Error('db down'));
    expect((await post({ workspaceIds: [W1], since: '2026-10-21T00:00:00Z' })).status).toBe(500);
  });
});
