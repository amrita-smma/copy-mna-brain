import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatcherTick, reapStuckRuns, createDbFn } = vi.hoisted(() => ({
  dispatcherTick: vi.fn(),
  reapStuckRuns: vi.fn(),
  createDbFn: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ dispatcherTick, reapStuckRuns }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbFn }));

import { GET } from './route';

function makeRequest(authHeader?: string): never {
  return {
    headers: {
      get: (name: string) => {
        if (name === 'authorization') return authHeader ?? null;
        return null;
      },
    },
  } as never;
}

describe('GET /api/cron/dispatch', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    dispatcherTick.mockReset();
    reapStuckRuns.mockReset();
    createDbFn.mockReset();
    createDbFn.mockReturnValue({});
    reapStuckRuns.mockResolvedValue({ reaped: [], scanned: 0 });
    dispatcherTick.mockResolvedValue({ outcome: 'empty' });
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  it('rejects unauthenticated callers when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 'sekret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(dispatcherTick).not.toHaveBeenCalled();
  });

  it('rejects callers with a wrong bearer token', async () => {
    process.env.CRON_SECRET = 'sekret';
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('runs the reaper and dispatcher on a valid call', async () => {
    process.env.CRON_SECRET = 'sekret';
    reapStuckRuns.mockResolvedValueOnce({ reaped: ['r1'], scanned: 1 });
    dispatcherTick.mockResolvedValueOnce({
      outcome: 'claimed',
      runId: 'r-claimed',
    });

    const res = await GET(makeRequest('Bearer sekret'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reaper).toEqual({ reaped: ['r1'], scanned: 1 });
    expect(body.dispatch).toEqual({ outcome: 'claimed', runId: 'r-claimed' });
  });

  it('is open when CRON_SECRET is unset (local dev)', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('returns 500 with error message when dispatch throws', async () => {
    delete process.env.CRON_SECRET;
    dispatcherTick.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('db down');
  });
});

