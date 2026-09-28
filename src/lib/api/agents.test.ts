import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSectorAgents } from './agents';

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchSectorAgents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/agents and unwraps { data }', async () => {
    const agents = [{ key: 'minerba', handle: '@minerba' }];
    const fetchMock = stubFetch(agents);

    await expect(fetchSectorAgents()).resolves.toEqual(agents);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.anything());
  });

  it('asks for deprecated agents with ?include_deprecated=1', async () => {
    const fetchMock = stubFetch([]);

    await fetchSectorAgents({ includeDeprecated: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/agents?include_deprecated=1', expect.anything());
  });
});
