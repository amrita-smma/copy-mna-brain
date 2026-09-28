import { describe, expect, it, vi } from 'vitest';
import type { SectorAgentEntry } from '@/lib/agents/sector/registry';

// A fixture registry: the shipped one has no deprecated agent.
vi.mock('@/lib/agents/sector/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/sector/registry')>();
  const entry = (key: string, deprecated: boolean, successorKey?: string): SectorAgentEntry =>
    ({ key, handle: `@${key}`, name: key, sector: key, description: '', deprecated, successorKey }) as SectorAgentEntry;
  const entries = [entry('minerba', true, 'bangun'), entry('bangun', false), entry('dikti', true)];
  const fixture = actual.createSectorRegistry(entries);
  return { ...actual, getSectorAgent: fixture.getSectorAgent };
});

import { describeRoutinePause, isRoutinePausedReason } from './pauseReason';

describe('isRoutinePausedReason', () => {
  it('accepts only the closed set', () => {
    expect(isRoutinePausedReason('agent_deprecated')).toBe(true);
    expect(isRoutinePausedReason('agent_incompatible')).toBe(true);
    expect(isRoutinePausedReason(null)).toBe(false);
    expect(isRoutinePausedReason('manual')).toBe(false);
  });
});

describe('describeRoutinePause', () => {
  it.each([
    ['agent_deprecated', 'minerba', 'Paused — @minerba was deprecated. Rebind the insight to @bangun to resume.'],
    ['agent_deprecated', 'dikti', 'Paused — @dikti was deprecated. Rebind the insight to resume.'],
    ['agent_incompatible', 'bangun', 'Paused — @bangun no longer fits this insight. Rebind the insight to resume.'],
    ['agent_deprecated', null, 'Paused — the bound agent was deprecated. Rebind the insight to resume.'],
    ['agent_deprecated', 'retired', 'Paused — @retired was deprecated. Rebind the insight to resume.'],
  ])('describes %s for %s', (reason, agentKey, text) => {
    expect(describeRoutinePause(reason, agentKey)).toBe(text);
  });

  it('is null for a running routine or a manual pause (no reason)', () => {
    expect(describeRoutinePause(null, 'minerba')).toBeNull();
    expect(describeRoutinePause(undefined, 'minerba')).toBeNull();
    expect(describeRoutinePause('something_else', 'minerba')).toBeNull();
  });
});
