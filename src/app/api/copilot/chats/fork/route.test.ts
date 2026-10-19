import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createContainerMock,
  chatCacheEnabledMock,
  getChatAgentGraphMock,
  findInWorkspaceMock,
  createMock,
  setTitleMock,
  recordFirstMessageMock,
  getMessagesMock,
  seedMessagesMock,
  extractFirstTurnMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  chatCacheEnabledMock: vi.fn(),
  getChatAgentGraphMock: vi.fn(),
  findInWorkspaceMock: vi.fn(),
  createMock: vi.fn(),
  setTitleMock: vi.fn(),
  recordFirstMessageMock: vi.fn(),
  getMessagesMock: vi.fn(),
  seedMessagesMock: vi.fn(),
  extractFirstTurnMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/flags', () => ({ chatCacheEnabled: chatCacheEnabledMock }));
vi.mock('@/lib/agents/analysis', () => ({
  extractFirstTurn: extractFirstTurnMock,
  HumanMessage: class HumanMessage {
    constructor(public content: string) {}
  },
  AIMessage: class AIMessage {
    constructor(public content: string) {}
  },
}));
vi.mock('@/lib/chat/chatAgent', () => ({ getChatAgentGraph: getChatAgentGraphMock }));

import { POST } from './route';

const SOURCE_ID = '11111111-2222-4333-8444-555555555555';

function req(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/copilot/chats/fork', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/copilot/chats/fork', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    chatCacheEnabledMock.mockReset().mockResolvedValue(false);
    findInWorkspaceMock.mockReset();
    createMock.mockReset().mockResolvedValue({ id: 'new-chat' });
    setTitleMock.mockReset();
    recordFirstMessageMock.mockReset();
    getMessagesMock.mockReset().mockResolvedValue([]);
    seedMessagesMock.mockReset();
    getChatAgentGraphMock
      .mockReset()
      .mockResolvedValue({ getMessages: getMessagesMock, seedMessages: seedMessagesMock });
    extractFirstTurnMock.mockReset().mockReturnValue({ userText: 'Q', assistantText: 'A' });
    createContainerMock.mockReset().mockReturnValue({
      copilotChatsService: {
        findInWorkspace: findInWorkspaceMock,
        create: createMock,
        setTitle: setTitleMock,
        recordFirstMessage: recordFirstMessageMock,
      },
    });
  });

  it("copies the source thread's agent onto the fork and reads through that agent", async () => {
    findInWorkspaceMock.mockResolvedValue({ id: SOURCE_ID, agent_key: 'bangun' });

    const res = await POST(req({ sourceChatId: SOURCE_ID }));

    expect(res.status).toBe(200);
    expect(getChatAgentGraphMock).toHaveBeenCalledWith('bangun');
    expect(createMock).toHaveBeenCalledWith('u1', 'bangun');
    expect(await res.json()).toEqual({ data: { chatId: 'new-chat' } });
  });

  it('returns 404 when the source chat is not in this workspace', async () => {
    findInWorkspaceMock.mockResolvedValue(null);

    const res = await POST(req({ sourceChatId: SOURCE_ID }));

    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed source id without querying', async () => {
    const res = await POST(req({ sourceChatId: 'not-a-uuid' }));

    expect(res.status).toBe(400);
    expect(findInWorkspaceMock).not.toHaveBeenCalled();
  });
});
