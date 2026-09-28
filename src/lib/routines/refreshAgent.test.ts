import { describe, expect, it, vi } from 'vitest';

const { listSectorAgentsMock } = vi.hoisted(() => ({ listSectorAgentsMock: vi.fn() }));

vi.mock('@/lib/agents/sector/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/sector/registry')>();
  return {
    ...actual,
    listSectorAgents: (...args: Parameters<typeof actual.listSectorAgents>) =>
      listSectorAgentsMock.getMockImplementation()
        ? listSectorAgentsMock(...args)
        : actual.listSectorAgents(...args),
  };
});

import {
  GENERAL_REFRESH_AGENT,
  listDeprecatedSectorAgentKeys,
  readRefreshInsightId,
  readRunAgentKey,
  resolveRefreshAgentKey,
} from './refreshAgent';

describe('resolveRefreshAgentKey', () => {
  it('keeps a registry key', () => {
    expect(resolveRefreshAgentKey('minerba')).toBe('minerba');
    expect(resolveRefreshAgentKey('bangun')).toBe('bangun');
  });

  it('resolves unbound and unknown bindings to general', () => {
    expect(resolveRefreshAgentKey(null)).toBe(GENERAL_REFRESH_AGENT);
    expect(resolveRefreshAgentKey(undefined)).toBe(GENERAL_REFRESH_AGENT);
    expect(resolveRefreshAgentKey('')).toBe(GENERAL_REFRESH_AGENT);
    expect(resolveRefreshAgentKey('retired')).toBe(GENERAL_REFRESH_AGENT);
  });
});

describe('readRunAgentKey', () => {
  it('reads a sector key from the run input', () => {
    expect(readRunAgentKey({ agent_key: 'dikti' })).toBe('dikti');
  });

  it('reads general, a missing key, an unknown key and a non-object as null (general workforce agent)', () => {
    expect(readRunAgentKey({ agent_key: 'general' })).toBeNull();
    expect(readRunAgentKey({ prompt: 'x' })).toBeNull();
    expect(readRunAgentKey({ agent_key: 'retired' })).toBeNull();
    expect(readRunAgentKey({ agent_key: 42 })).toBeNull();
    expect(readRunAgentKey(null)).toBeNull();
    expect(readRunAgentKey('bangun')).toBeNull();
  });
});

describe('listDeprecatedSectorAgentKeys', () => {
  it('is empty for the shipped registry', () => {
    expect(listDeprecatedSectorAgentKeys()).toEqual([]);
  });

  it('lists only the deprecated entries, asking the registry to include them', () => {
    listSectorAgentsMock.mockImplementation(() => [
      { key: 'minerba', deprecated: false },
      { key: 'bangun', deprecated: true },
    ]);
    expect(listDeprecatedSectorAgentKeys()).toEqual(['bangun']);
    expect(listSectorAgentsMock).toHaveBeenCalledWith({ includeDeprecated: true });
    listSectorAgentsMock.mockReset();
  });
});

describe('readRefreshInsightId', () => {
  const INSIGHT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  it('reads a routine run\'s insight from trigger_meta, then from input (a retry has only input)', () => {
    expect(readRefreshInsightId({ origin_routine_id: 'r1', trigger_meta: { insight_id: INSIGHT }, input: { insight_id: OTHER } })).toBe(INSIGHT);
    expect(readRefreshInsightId({ origin_routine_id: 'r1', trigger_meta: null, input: { insight_id: INSIGHT } })).toBe(INSIGHT);
  });

  it('treats a run without a routine as a refresh only when the one-off flag is set (MB-552)', () => {
    expect(readRefreshInsightId({ origin_routine_id: null, trigger_meta: {}, input: { insight_id: INSIGHT, insight_refresh: true } })).toBe(INSIGHT);
    expect(readRefreshInsightId({ origin_routine_id: null, trigger_meta: { insight_id: INSIGHT }, input: { insight_id: INSIGHT } })).toBeNull();
    expect(readRefreshInsightId({ origin_routine_id: null, trigger_meta: {}, input: { insight_id: INSIGHT, insight_refresh: 'true' } })).toBeNull();
  });

  it('ignores ids that are not UUIDs and non-object payloads', () => {
    expect(readRefreshInsightId({ origin_routine_id: 'r1', trigger_meta: { insight_id: 'abc' }, input: 'x' })).toBeNull();
    expect(readRefreshInsightId({ origin_routine_id: undefined, trigger_meta: undefined, input: undefined })).toBeNull();
  });
});
