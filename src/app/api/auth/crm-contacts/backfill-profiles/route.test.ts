import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  createContainer: vi.fn(),
  backfillProfiles: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { POST } from './route';

const W1 = '00000000-0000-0000-0000-000000000001';

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/auth/crm-contacts/backfill-profiles', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/auth/crm-contacts/backfill-profiles', () => {
  beforeEach(() => {
    mocks.createDb.mockReset().mockReturnValue({ db: true });
    mocks.backfillProfiles.mockReset().mockResolvedValue({ candidates: 3, queued: 2 });
    mocks.createContainer.mockReset().mockReturnValue({
      crmContactEnrichmentService: { backfillProfiles: mocks.backfillProfiles },
    });
  });

  it('queues the backfill in the given workspace', async () => {
    const res = await post({ workspaceId: W1, limit: 25, minEmailsFromThem: 3 });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { candidates: 3, queued: 2 } });
    expect(mocks.createContainer).toHaveBeenCalledWith({ db: true }, W1);
    expect(mocks.backfillProfiles).toHaveBeenCalledWith(25, 3);
  });

  it('defaults minEmailsFromThem to 1', async () => {
    await post({ workspaceId: W1, limit: 5 });
    expect(mocks.backfillProfiles).toHaveBeenCalledWith(5, 1);
  });

  it.each([
    [{ limit: 5 }],
    [{ workspaceId: 'nope', limit: 5 }],
    [{ workspaceId: W1 }],
    [{ workspaceId: W1, limit: 0 }],
    [{ workspaceId: W1, limit: 2.5 }],
    [{ workspaceId: W1, limit: 5, minEmailsFromThem: 0 }],
    ['not json'],
  ])('rejects a bad body %j with 400 and queues nothing', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mocks.backfillProfiles).not.toHaveBeenCalled();
  });

  it('returns 500 when the backfill throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.backfillProfiles.mockRejectedValueOnce(new Error('db down'));
    const res = await post({ workspaceId: W1, limit: 5 });
    expect(res.status).toBe(500);
  });
});
