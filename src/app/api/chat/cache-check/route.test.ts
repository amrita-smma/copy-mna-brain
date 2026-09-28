import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createContainerMock,
  chatCacheEnabledMock,
  resolveChatAgentKeyMock,
  getChatAgentGraphMock,
  findCachedFirstTurnMock,
  getMessagesMock,
  extractFirstTurnMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  chatCacheEnabledMock: vi.fn(),
  resolveChatAgentKeyMock: vi.fn(),
  getChatAgentGraphMock: vi.fn(),
  findCachedFirstTurnMock: vi.fn(),
  getMessagesMock: vi.fn(),
  extractFirstTurnMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/flags', () => ({ chatCacheEnabled: chatCacheEnabledMock }));
vi.mock('@/lib/agents/analysis', () => ({ extractFirstTurn: extractFirstTurnMock }));
vi.mock('@/lib/chat/chatAgent', () => ({
  resolveChatAgentKey: resolveChatAgentKeyMock,
  getChatAgentGraph: getChatAgentGraphMock,
}));

import { POST } from './route';

const INSIGHT_ID = '99999999-8888-4777-8666-555555555555';

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/chat/cache-check', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat/cache-check', () => {
  const copilotChatsService = { findCachedFirstTurn: findCachedFirstTurnMock };
  const insightService = { findBoundAgent: vi.fn() };

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    chatCacheEnabledMock.mockReset().mockResolvedValue(true);
    createContainerMock.mockReset().mockReturnValue({ copilotChatsService, insightService });
    resolveChatAgentKeyMock.mockReset();
    findCachedFirstTurnMock.mockReset();
    getMessagesMock.mockReset().mockResolvedValue([]);
    getChatAgentGraphMock.mockReset().mockResolvedValue({ getMessages: getMessagesMock });
    extractFirstTurnMock.mockReset().mockReturnValue({
      userText: 'Who builds cheapest?',
      assistantText: 'A long enough cached answer with more than six words.',
    });
  });

  it('returns a hit read through the matched chat\'s own agent graph', async () => {
    resolveChatAgentKeyMock.mockResolvedValue({ agentKey: 'general', notice: null, firstTurn: true });
    findCachedFirstTurnMock.mockResolvedValue({ id: 'c9', agent_key: 'general', created_at: 't' });

    const res = await POST(
      req({ message: 'Who builds cheapest?', page_context: { tabSlug: null, path: '/pipeline' } }),
    );

    expect(resolveChatAgentKeyMock).toHaveBeenCalledWith(
      { chat: null, pageContext: expect.objectContaining({ path: '/pipeline' }) },
      { workspaceId: 'ws-1', copilotChatsService, insightService },
    );
    expect(findCachedFirstTurnMock).toHaveBeenCalledWith('Who builds cheapest?', 'general');
    expect(getChatAgentGraphMock).toHaveBeenCalledWith('general');
    expect((await res.json()).data.hit).toBe(true);
  });

  it('misses without a lookup for a new chat opened on an insight, whatever its agent', async () => {
    // The turn would carry the insight's outline (MB-550), so it is never cached.
    resolveChatAgentKeyMock.mockResolvedValue({ agentKey: 'bangun', notice: null, firstTurn: true });
    findCachedFirstTurnMock.mockResolvedValue({ id: 'c9', agent_key: 'bangun', created_at: 't' });

    const res = await POST(
      req({
        message: 'Who builds cheapest?',
        page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
      }),
    );

    expect(await res.json()).toEqual({ data: { hit: false } });
    expect(resolveChatAgentKeyMock).not.toHaveBeenCalled();
    expect(findCachedFirstTurnMock).not.toHaveBeenCalled();
  });

  it('misses without a lookup when the resolver says the new chat would carry a notice', async () => {
    resolveChatAgentKeyMock.mockResolvedValue({ agentKey: 'general', notice: 'NO AGENT NOTICE', firstTurn: true });

    const res = await POST(req({ message: 'Who builds cheapest?' }));

    expect(await res.json()).toEqual({ data: { hit: false } });
    expect(findCachedFirstTurnMock).not.toHaveBeenCalled();
  });

  it('misses when no cached general chat matches', async () => {
    resolveChatAgentKeyMock.mockResolvedValue({ agentKey: 'general', notice: null, firstTurn: true });
    findCachedFirstTurnMock.mockResolvedValue(null);

    const res = await POST(req({ message: 'Hello there' }));

    expect(findCachedFirstTurnMock).toHaveBeenCalledWith('Hello there', 'general');
    expect(await res.json()).toEqual({ data: { hit: false } });
  });
});
