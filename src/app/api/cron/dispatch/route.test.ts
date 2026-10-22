import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatcherTick, reapStuckRuns, fireDueRoutines, sweepBotRequests, sweepUnembeddedChatMessages, createDbFn } = vi.hoisted(() => ({
  dispatcherTick: vi.fn(),
  reapStuckRuns: vi.fn(),
  fireDueRoutines: vi.fn(),
  sweepBotRequests: vi.fn(),
  sweepUnembeddedChatMessages: vi.fn(),
  createDbFn: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ dispatcherTick, reapStuckRuns }));
vi.mock('@/lib/routines', () => ({ fireDueRoutines }));
vi.mock('@/lib/bots/requestSweep', () => ({ sweepBotRequests }));
vi.mock('@/lib/chat/embeddingSweep', () => ({ sweepUnembeddedChatMessages }));
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
    fireDueRoutines.mockReset();
    createDbFn.mockReset();
    createDbFn.mockReturnValue({});
    reapStuckRuns.mockResolvedValue({ reaped: [], scanned: 0 });
    fireDueRoutines.mockResolvedValue({ scanned: 0, fired: [], errors: [] });
    dispatcherTick.mockResolvedValue({ outcome: 'empty' });
    sweepBotRequests.mockReset().mockResolvedValue({ timedOut: 0, workspaces: 0 });
    sweepUnembeddedChatMessages.mockReset().mockResolvedValue({ queued: 0, workspaces: 0 });
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
    expect(body.routines).toEqual({ scanned: 0, fired: [], errors: [] });
    expect(body.dispatch).toEqual({ outcome: 'claimed', runId: 'r-claimed' });
    expect(fireDueRoutines).toHaveBeenCalledTimes(1);
    expect(sweepBotRequests).toHaveBeenCalledWith({});
    expect(body.botRequests).toEqual({ timedOut: 0, workspaces: 0 });
    expect(sweepUnembeddedChatMessages).toHaveBeenCalledWith({});
    expect(body.embeddings).toEqual({ queued: 0, workspaces: 0 });
  });

  it('backfills chat-history vectors on each tick, and a failed sweep does not fail the tick', async () => {
    delete process.env.CRON_SECRET;
    sweepUnembeddedChatMessages.mockResolvedValueOnce({ queued: 7, workspaces: 2 });
    expect((await (await GET(makeRequest())).json()).embeddings).toEqual({ queued: 7, workspaces: 2 });

    sweepUnembeddedChatMessages.mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).embeddings).toEqual({ queued: 0, workspaces: 0 });
    error.mockRestore();
  });

  it('times out stale bot requests on each tick, and a failed sweep does not fail the tick', async () => {
    delete process.env.CRON_SECRET;
    sweepBotRequests.mockResolvedValueOnce({ timedOut: 2, workspaces: 1 });
    expect((await (await GET(makeRequest())).json()).botRequests).toEqual({ timedOut: 2, workspaces: 1 });

    sweepBotRequests.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).botRequests).toEqual({ timedOut: 0, workspaces: 0 });
    error.mockRestore();
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

