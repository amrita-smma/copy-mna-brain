import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { listSectorAgentsMock } = vi.hoisted(() => ({ listSectorAgentsMock: vi.fn() }));

vi.mock('@/lib/agents/sector/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSectorAgents: listSectorAgentsMock,
}));

// proxy.ts builds a NextAuth middleware at import time; stub it (as
// proxy.test.ts does) so only the pure route classifier is exercised.
vi.mock('next-auth', () => ({
  default: () => ({ auth: (handler: unknown) => handler }),
}));
vi.mock('@/auth.config', () => ({ authConfig: {} }));

import { GET } from './route';
import { classifyApiRoute } from '@/proxy';

describe('GET /api/agents', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof import('@/lib/agents/sector/registry')>(
      '@/lib/agents/sector/registry',
    );
    listSectorAgentsMock.mockReset().mockImplementation(real.listSectorAgents);
  });

  it('returns the three non-deprecated registry entries as { data }', async () => {
    const res = await GET(new NextRequest('http://localhost/api/agents'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.map((a: { handle: string }) => a.handle)).toEqual([
      '@minerba',
      '@dikti',
      '@bangun',
    ]);
    expect(json.data[0]).toEqual(
      expect.objectContaining({
        key: 'minerba',
        name: 'Mining and Minerals Agent',
        sector: 'Mining and minerals',
        deprecated: false,
      }),
    );
    expect(listSectorAgentsMock).toHaveBeenCalledWith({ includeDeprecated: false });
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
  ])('reads ?include_deprecated=%s as includeDeprecated: %s', async (flag, includeDeprecated) => {
    await GET(new NextRequest(`http://localhost/api/agents?include_deprecated=${flag}`));
    expect(listSectorAgentsMock).toHaveBeenCalledWith({ includeDeprecated });
  });

  it('returns a 500 { error } when the registry throws', async () => {
    listSectorAgentsMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(new NextRequest('http://localhost/api/agents'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    spy.mockRestore();
  });

  it('is gated by a user session in the proxy middleware', () => {
    expect(classifyApiRoute('/api/agents')).toBe('session');
  });
});
