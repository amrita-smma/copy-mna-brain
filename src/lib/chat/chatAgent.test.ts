import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getAgentGraphMock, getSectorAgentGraphMock } = vi.hoisted(() => ({
  getAgentGraphMock: vi.fn(),
  getSectorAgentGraphMock: vi.fn(),
}));

// The real builders pull in the whole LangChain agent stack; the resolver only
// decides which one to call.
vi.mock('@/lib/agents/analysis', () => ({ getAgentGraph: getAgentGraphMock }));
vi.mock('@/lib/agents/sector/graph', () => ({ getSectorAgentGraph: getSectorAgentGraphMock }));

import {
  NO_SECTOR_AGENT_NOTICE,
  UNAVAILABLE_SECTOR_AGENT_NOTICE,
  getChatAgentGraph,
  resolveChatAgentGraph,
  resolveChatAgentKey,
} from './chatAgent';
import { createSectorRegistry } from '@/lib/agents/sector/registry';
import type { SectorAgentEntry } from '@/lib/agents/sector/types';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const INSIGHT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_INSIGHT_ID = '99999999-8888-4777-8666-555555555555';

const onInsight = (insightId: string) => ({ tabSlug: 'insight', path: '/insight', insightId });

describe('resolveChatAgentKey', () => {
  const pinAgent = vi.fn();
  const findBoundAgent = vi.fn();
  const deps = () => ({
    workspaceId: WORKSPACE_ID,
    copilotChatsService: { pinAgent },
    insightService: { findBoundAgent },
  });
  type PageContext = Parameters<typeof resolveChatAgentKey>[0]['pageContext'];
  const resolve = (agentKey: string | null, pageContext: PageContext = onInsight(INSIGHT_ID)) =>
    resolveChatAgentKey({ chat: { id: 'c1', agent_key: agentKey }, pageContext }, deps());

  beforeEach(() => {
    pinAgent.mockReset().mockImplementation(async (_id: string, key: string) => key);
    findBoundAgent.mockReset();
  });

  it("pins a first turn from a bound insight to that insight's sector agent", async () => {
    findBoundAgent.mockResolvedValueOnce({ agentKey: 'bangun' });

    expect(await resolve(null)).toEqual({ agentKey: 'bangun', notice: null, firstTurn: true });
    expect(findBoundAgent).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
    expect(pinAgent).toHaveBeenCalledWith('c1', 'bangun');
  });

  it('pins an unbound insight to general and adds the no-agent notice on that turn', async () => {
    findBoundAgent.mockResolvedValueOnce({ agentKey: null });

    expect(await resolve(null)).toEqual({ agentKey: 'general', notice: NO_SECTOR_AGENT_NOTICE, firstTurn: true });
    expect(pinAgent).toHaveBeenCalledWith('c1', 'general');
  });

  it('does not repeat the no-agent notice on a later turn of that thread', async () => {
    expect(await resolve('general')).toEqual({ agentKey: 'general', notice: null, firstTurn: false });
    expect(findBoundAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['off an insight page', { tabSlug: 'crm', path: '/crm' }],
    ['with no page context', null],
  ])('pins a chat started %s to general with no notice', async (_label, pageContext) => {
    expect(await resolve(null, pageContext)).toEqual({ agentKey: 'general', notice: null, firstTurn: true });
    expect(findBoundAgent).not.toHaveBeenCalled();
    expect(pinAgent).toHaveBeenCalledWith('c1', 'general');
  });

  it('keeps a pinned thread on its agent when a later turn comes from a different insight', async () => {
    findBoundAgent.mockResolvedValue({ agentKey: 'dikti' });

    expect(await resolve('bangun', onInsight(OTHER_INSIGHT_ID))).toEqual({
      agentKey: 'bangun',
      notice: null,
      firstTurn: false,
    });
    expect(findBoundAgent).not.toHaveBeenCalled();
    expect(pinAgent).not.toHaveBeenCalled();
  });

  it('resolves an unknown bound key to general with the agent-unavailable notice, not the no-agent one', async () => {
    findBoundAgent.mockResolvedValueOnce({ agentKey: 'retired-agent' });

    expect(await resolve(null)).toEqual({
      agentKey: 'general',
      notice: UNAVAILABLE_SECTOR_AGENT_NOTICE,
      firstTurn: true,
    });
    expect(UNAVAILABLE_SECTOR_AGENT_NOTICE).not.toBe(NO_SECTOR_AGENT_NOTICE);
    expect(pinAgent).toHaveBeenCalledWith('c1', 'general');
  });

  it('treats an insight from another workspace as not found: general, no notice', async () => {
    findBoundAgent.mockResolvedValueOnce(null);

    expect(await resolve(null)).toEqual({ agentKey: 'general', notice: null, firstTurn: true });
  });

  it('reads an unknown pinned key as general', async () => {
    expect((await resolve('retired-agent', null)).agentKey).toBe('general');
  });

  it('keeps resolving a deprecated agent that is still bound', async () => {
    const agent = (key: SectorAgentEntry['key'], extra: Partial<SectorAgentEntry> = {}) => ({
      key,
      handle: `@${key}`,
      name: key,
      sector: key,
      description: 'd',
      deprecated: false,
      ...extra,
    });
    const registry = createSectorRegistry([
      agent('minerba', { deprecated: true, successorKey: 'bangun' }),
      agent('bangun'),
    ]);
    findBoundAgent.mockResolvedValueOnce({ agentKey: 'minerba' });

    const result = await resolveChatAgentKey(
      { chat: { id: 'c1', agent_key: null }, pageContext: onInsight(INSIGHT_ID) },
      { ...deps(), registry },
    );

    expect(result.agentKey).toBe('minerba');
    expect(pinAgent).toHaveBeenCalledWith('c1', 'minerba');
  });

  it("uses the agent a concurrent first turn already pinned, and drops this turn's notice", async () => {
    findBoundAgent.mockResolvedValueOnce({ agentKey: null });
    pinAgent.mockResolvedValueOnce('bangun');

    expect(await resolve(null)).toEqual({ agentKey: 'bangun', notice: null, firstTurn: false });
  });

  it('previews without pinning when there is no chat yet', async () => {
    findBoundAgent.mockResolvedValueOnce({ agentKey: 'dikti' });

    const result = await resolveChatAgentKey({ chat: null, pageContext: onInsight(INSIGHT_ID) }, deps());

    expect(result.agentKey).toBe('dikti');
    expect(pinAgent).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  getAgentGraphMock.mockReset().mockResolvedValue('general-graph');
  getSectorAgentGraphMock.mockReset().mockResolvedValue('sector-graph');
});

describe('getChatAgentGraph', () => {
  it("builds a sector thread's chat graph and ignores the workspace flavour", async () => {
    const graph = await getChatAgentGraph('bangun', { effort: 'high', flavour: 'vc', sof: false });

    expect(graph).toBe('sector-graph');
    expect(getSectorAgentGraphMock).toHaveBeenCalledWith('bangun', 'chat', 'high');
    expect(getAgentGraphMock).not.toHaveBeenCalled();
  });

  it("builds a general thread on the workspace flavour, effort and source-of-funds gate", async () => {
    const graph = await getChatAgentGraph('general', { effort: 'low', flavour: 'investment', sof: false });

    expect(graph).toBe('general-graph');
    expect(getAgentGraphMock).toHaveBeenCalledWith('investment', 'low', false);
    expect(getSectorAgentGraphMock).not.toHaveBeenCalled();
  });

  it("defaults to getAgentGraph()'s own defaults", async () => {
    await getChatAgentGraph('general');

    expect(getAgentGraphMock).toHaveBeenCalledWith('mna', 'medium', true);
  });
});

describe('resolveChatAgentGraph', () => {
  it('resolves, pins and builds the sector graph for a first turn on a bound insight', async () => {
    const pinAgent = vi.fn(async (_id: string, key: string) => key);
    const findBoundAgent = vi.fn().mockResolvedValue({ agentKey: 'dikti' });

    const result = await resolveChatAgentGraph(
      {
        chat: { id: 'c1', agent_key: null },
        pageContext: onInsight(INSIGHT_ID),
        effort: 'medium',
        flavour: 'mna',
        sof: true,
      },
      { workspaceId: WORKSPACE_ID, copilotChatsService: { pinAgent }, insightService: { findBoundAgent } },
    );

    expect(result).toEqual({ agentKey: 'dikti', notice: null, firstTurn: true, graph: 'sector-graph' });
    expect(getSectorAgentGraphMock).toHaveBeenCalledWith('dikti', 'chat', 'medium');
  });
});
