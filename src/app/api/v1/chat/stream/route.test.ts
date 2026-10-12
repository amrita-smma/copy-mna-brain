import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createContainerMock,
  prepareConversationRunMock,
  resolveChatAgentGraphMock,
  streamEventsMock,
  eventStreamToSseMock,
} = vi.hoisted(() => ({
  createContainerMock: vi.fn(),
  prepareConversationRunMock: vi.fn(),
  resolveChatAgentGraphMock: vi.fn(),
  streamEventsMock: vi.fn(),
  eventStreamToSseMock: vi.fn(() => new ReadableStream()),
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
  eventStreamToSse: eventStreamToSseMock,
  langfuseUserForApiKey: (principal: { id: string }) => `api-key:${principal.id}`,
}));
vi.mock('@/lib/chat/chatAgent', () => ({ resolveChatAgentGraph: resolveChatAgentGraphMock }));

// Deliberately NOT mocked: the point of the attribution assertion below is
// that the real AsyncLocalStorage is in scope when the graph is driven.
import { getLangfuseUserId } from '@/lib/langfuseUser';
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
      principal: { id: 'key-1', name: 'bot', scopes: ['chat:write'] },
      conversationId: 'conv-1',
      messages: [],
      originalUserQuestion: 'Q',
    });
    streamEventsMock.mockReset().mockResolvedValue({});
    eventStreamToSseMock.mockClear();
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

  it('builds the SSE reader inside the user scope, so the drain is attributed too', async () => {
    // The reader drains the event stream — and so runs the tools — from inside
    // its own `start`. Opening the scope around `streamEvents` alone would
    // leave a trace a tool hand-builds mid-drain (the pptx skill)
    // unattributed; `eventStreamToSse` covers that in its own test.
    let userWhenReaderBuilt: string | undefined;
    eventStreamToSseMock.mockImplementation(() => {
      userWhenReaderBuilt = getLangfuseUserId();
      return new ReadableStream();
    });

    await POST(
      new NextRequest('http://localhost/api/v1/chat/stream', { method: 'POST', body: '{}' }),
    );

    expect(userWhenReaderBuilt).toBe('api-key:key-1');
  });

  it('drives the graph under the calling API key, which has no user of its own', async () => {
    let userDuringRun: string | undefined;
    streamEventsMock.mockImplementation(async () => {
      userDuringRun = getLangfuseUserId();
      return {};
    });

    await POST(
      new NextRequest('http://localhost/api/v1/chat/stream', { method: 'POST', body: '{}' }),
    );

    expect(userDuringRun).toBe('api-key:key-1');
    // And the store does not leak past the call that opened it.
    expect(getLangfuseUserId()).toBeUndefined();
  });
});
