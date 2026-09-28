import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SectorAgentEntry } from '@/lib/agents/sector/types';

const { getSectorAgentMock } = vi.hoisted(() => ({ getSectorAgentMock: vi.fn() }));

vi.mock('@/lib/agents/sector/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSectorAgent: getSectorAgentMock,
}));

import { readConfiguredAgentStamp, resolveInsightAgentStamp } from './agentStamp';

beforeEach(async () => {
  const real = await vi.importActual<typeof import('@/lib/agents/sector/registry')>('@/lib/agents/sector/registry');
  getSectorAgentMock.mockReset().mockImplementation(real.getSectorAgent);
});

describe('resolveInsightAgentStamp', () => {
  it("returns the agent's key", () => {
    expect(resolveInsightAgentStamp('bangun')).toEqual({ agentKey: 'bangun' });
  });

  it('returns null for no key', () => {
    expect(resolveInsightAgentStamp(null)).toBeNull();
    expect(resolveInsightAgentStamp(undefined)).toBeNull();
    expect(resolveInsightAgentStamp('')).toBeNull();
    expect(getSectorAgentMock).not.toHaveBeenCalled();
  });

  it('returns null for a key the registry does not know', () => {
    expect(resolveInsightAgentStamp('nope')).toBeNull();
  });

  it('still resolves a deprecated agent, which an existing binding keeps running on', () => {
    const deprecated: SectorAgentEntry = {
      key: 'minerba', handle: '@minerba', name: 'm', sector: 'm', description: 'd', deprecated: true,
    };
    getSectorAgentMock.mockReturnValue(deprecated);

    expect(resolveInsightAgentStamp('minerba')).toEqual({ agentKey: 'minerba' });
  });
});

describe('readConfiguredAgentStamp', () => {
  it('stamps the sector agent named by configurable.agent_key', () => {
    expect(readConfiguredAgentStamp({ agent_key: 'bangun' })).toEqual({
      agentKey: 'bangun',
    });
  });

  it.each([
    [{ agent_key: 'general' }],
    [{ agent_key: 42 }],
    [{}],
    [undefined],
  ])('returns null for %j', (configurable) => {
    expect(readConfiguredAgentStamp(configurable as Record<string, unknown> | undefined)).toBeNull();
  });
});
