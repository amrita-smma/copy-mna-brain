import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createContainerMock, prepareConversationRunMock, resolveChatAgentGraphMock, invokeMock } =
  vi.hoisted(() => ({
    createContainerMock: vi.fn(),
    prepareConversationRunMock: vi.fn(),
    resolveChatAgentGraphMock: vi.fn(),
    invokeMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/agents/analysis', () => ({
  AIMessage: class AIMessage {},
  extractMessageText: () => 'reply',
}));
vi.mock('@/lib/server/apiChatSupport', () => ({
  ChatRequestError: class ChatRequestError extends Error {
    status = 400;
  },
  prepareConversationRun: prepareConversationRunMock,
}));
vi.mock('@/lib/chat/chatAgent', () => ({ resolveChatAgentGraph: resolveChatAgentGraphMock }));

import { POST } from './route';

describe('POST /api/v1/chat', () => {
  const services = {
    apiKeyService: {},
    apiChatConversationService: {},
    copilotChatsService: {},
    insightService: {},
  };

  beforeEach(() => {
    createContainerMock.mockReset().mockReturnValue(services);
    prepareConversationRunMock.mockReset().mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      originalUserQuestion: 'Q',
    });
    invokeMock.mockReset().mockResolvedValue({ messages: [] });
    resolveChatAgentGraphMock.mockReset().mockResolvedValue({
      graph: { invoke: invokeMock },
      agentKey: 'general',
      notice: null,
      firstTurn: true,
    });
  });

  it('runs through the chat agent resolver as a general, page-less conversation', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/v1/chat', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(200);
    expect(resolveChatAgentGraphMock).toHaveBeenCalledWith(
      { chat: null, pageContext: null },
      { workspaceId: 'ws-1', copilotChatsService: services.copilotChatsService, insightService: services.insightService },
    );
    expect(invokeMock.mock.calls[0][1].configurable).toEqual({
      thread_id: 'conv-1',
      originalUserQuestion: 'Q',
      agent_key: 'general',
    });
  });

  it('returns 503 when the agent is unavailable', async () => {
    resolveChatAgentGraphMock.mockResolvedValue({ graph: null, agentKey: 'general', notice: null, firstTurn: true });

    const res = await POST(
      new NextRequest('http://localhost/api/v1/chat', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(503);
  });
});
