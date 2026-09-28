import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SectorAgentEntry } from '@/lib/agents/sector/types';

const { getSectorAgentMock } = vi.hoisted(() => ({ getSectorAgentMock: vi.fn() }));

vi.mock('@/lib/agents/sector/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSectorAgent: getSectorAgentMock,
}));

import { describeInsightAgent } from './agentLabel';

const entry = (key: SectorAgentEntry['key'], extra: Partial<SectorAgentEntry> = {}): SectorAgentEntry => ({
  key,
  handle: `@${key}`,
  name: `${key} agent`,
  sector: `${key} sector`,
  description: 'd',
  deprecated: false,
  ...extra,
});

describe('describeInsightAgent', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof import('@/lib/agents/sector/registry')>(
      '@/lib/agents/sector/registry',
    );
    getSectorAgentMock.mockReset().mockImplementation(real.getSectorAgent);
  });

  it('returns null when the insight is unbound', () => {
    expect(describeInsightAgent(null)).toBeNull();
    expect(describeInsightAgent(undefined)).toBeNull();
  });

  it('resolves a shipped agent to its handle, name and sector', () => {
    expect(describeInsightAgent('bangun')).toEqual({
      key: 'bangun',
      handle: '@bangun',
      name: 'Construction and Property Development Agent',
      sector: 'Construction and property development',
      deprecated: false,
      successorHandle: null,
    });
  });

  it('marks a deprecated agent and names its successor', () => {
    getSectorAgentMock.mockImplementation((key: string) =>
      key === 'minerba'
        ? entry('minerba', { deprecated: true, successorKey: 'bangun' })
        : entry(key as SectorAgentEntry['key']),
    );

    expect(describeInsightAgent('minerba')).toMatchObject({
      handle: '@minerba',
      deprecated: true,
      successorHandle: '@bangun',
    });
  });

  it('falls back to @key for a key the registry does not know', () => {
    expect(describeInsightAgent('gone')).toEqual({
      key: 'gone',
      handle: '@gone',
      name: null,
      sector: null,
      deprecated: false,
      successorHandle: null,
    });
  });
});
