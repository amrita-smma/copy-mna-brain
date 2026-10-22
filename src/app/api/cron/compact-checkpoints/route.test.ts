import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createContainerMock, runMock } = vi.hoisted(() => ({
  createContainerMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

const req = (auth?: string) =>
  new NextRequest('http://localhost/api/cron/compact-checkpoints', {
    headers: auth ? { authorization: auth } : {},
  });

describe('GET /api/cron/compact-checkpoints', () => {
  beforeEach(() => {
    runMock.mockReset().mockResolvedValue({ threads: 3, failed: 0, checkpoints: 9, writes: 2, blobs: 1 });
    createContainerMock.mockReset().mockReturnValue({ checkpointCompactionService: { run: runMock } });
    vi.stubEnv('CRON_SECRET', 'shh');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('runs one compaction pass and reports it', async () => {
    const res = await GET(req('Bearer shh'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, threads: 3, failed: 0, checkpoints: 9, writes: 2, blobs: 1 });
  });

  it('rejects a caller without the cron secret', async () => {
    const res = await GET(req('Bearer nope'));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('500s when the pass fails', async () => {
    runMock.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req('Bearer shh'))).status).toBe(500);
    spy.mockRestore();
  });
});
