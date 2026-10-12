import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createContainerMock, prepareConversationRunMock, resolveChatAgentGraphMock, streamEventsMock } =
  vi.hoisted(() => ({
    createContainerMock: vi.fn(),
    prepareConversationRunMock: vi.fn(),
    resolveChatAgentGraphMock: vi.fn(),
    streamEventsMock: vi.fn(),
  }));

// `after()` throws outside a request scope, so stub it the way the Copilot
// chat route test does. The route uses it to drain Langfuse once the SSE body
// has finished streaming.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/server/apiChatSupport', () => ({
  ChatRequestError: class ChatRequestError extends Error {
    status = 400;
  },
  prepareConversationRun: prepareConversationRunMock,
  eventStreamToSse: () => new ReadableStream(),
}));
vi.mock('@/lib/chat/chatAgent', () => ({ resolveChatAgentGraph: resolveChatAgentGraphMock }));

import { POST } from './route';

describe('POST /api/v1/chat/stream', () => {
  beforeEach(() => {
    createContainerMock.mockReset().mockReturnValue({
      apiKeyService: {},
      apiChatConversationService: {},
      copilotChatsService: {},
      insightService: {},
    });
    prepareConversationRunMock.mockReset().mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      originalUserQuestion: 'Q',
    });
    streamEventsMock.mockReset().mockResolvedValue({});
    resolveChatAgentGraphMock.mockReset().mockResolvedValue({
      graph: { streamEvents: streamEventsMock },
      agentKey: 'general',
      notice: null,
      firstTurn: true,
    });
  });

  it('streams on the graph the chat agent resolver picked', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/v1/chat/stream', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(200);
    expect(resolveChatAgentGraphMock).toHaveBeenCalledWith(
      { chat: null, pageContext: null },
      expect.objectContaining({ workspaceId: 'ws-1' }),
    );
    expect(streamEventsMock.mock.calls[0][1].configurable.agent_key).toBe('general');
  });
});
