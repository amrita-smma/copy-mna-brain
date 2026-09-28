import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, assertOwnedByMock, getChatAgentGraphMock, getMessagesMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createContainerMock: vi.fn(),
    assertOwnedByMock: vi.fn(),
    getChatAgentGraphMock: vi.fn(),
    getMessagesMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/chat/chatAgent', () => ({ getChatAgentGraph: getChatAgentGraphMock }));

import { GET } from './route';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';

describe('GET /api/copilot/chats/[id]/messages', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    assertOwnedByMock.mockReset();
    getMessagesMock.mockReset().mockResolvedValue([]);
    getChatAgentGraphMock.mockReset().mockResolvedValue({ getMessages: getMessagesMock });
    createContainerMock.mockReset().mockReturnValue({
      copilotChatsService: { assertOwnedBy: assertOwnedByMock },
    });
  });

  it("reads the thread through its pinned agent's graph", async () => {
    assertOwnedByMock.mockResolvedValue({ id: CHAT_ID, agent_key: 'dikti' });

    const res = await GET(new NextRequest(`http://localhost/api/copilot/chats/${CHAT_ID}/messages`), {
      params: Promise.resolve({ id: CHAT_ID }),
    });

    expect(res.status).toBe(200);
    expect(getChatAgentGraphMock).toHaveBeenCalledWith('dikti');
    expect(getMessagesMock).toHaveBeenCalledWith(CHAT_ID);
  });

  it('reads an unresolved thread through the general graph', async () => {
    assertOwnedByMock.mockResolvedValue({ id: CHAT_ID, agent_key: null });

    await GET(new NextRequest(`http://localhost/api/copilot/chats/${CHAT_ID}/messages`), {
      params: Promise.resolve({ id: CHAT_ID }),
    });

    expect(getChatAgentGraphMock).toHaveBeenCalledWith('general');
  });
});
