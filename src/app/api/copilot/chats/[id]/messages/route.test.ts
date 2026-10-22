import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, assertOwnedByMock, pageMock, getChatAgentGraphMock, getMessagesMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createContainerMock: vi.fn(),
    assertOwnedByMock: vi.fn(),
    pageMock: vi.fn(),
    getChatAgentGraphMock: vi.fn(),
    getMessagesMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/chat/chatAgent', () => ({ getChatAgentGraph: getChatAgentGraphMock }));

import { GET } from './route';
import { CopilotChatForbiddenError } from '@/lib/services/copilotChatsService';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const url = (query = '') => new NextRequest(`http://localhost/api/copilot/chats/${CHAT_ID}/messages${query}`);
const params = { params: Promise.resolve({ id: CHAT_ID }) };

describe('GET /api/copilot/chats/[id]/messages', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    assertOwnedByMock.mockReset().mockResolvedValue({ id: CHAT_ID, agent_key: 'dikti' });
    pageMock.mockReset().mockResolvedValue({ messages: [{ id: 'm1' }], nextCursor: 7 });
    getMessagesMock.mockReset().mockResolvedValue([]);
    getChatAgentGraphMock.mockReset().mockResolvedValue({ getMessages: getMessagesMock });
    createContainerMock.mockReset().mockReturnValue({
      copilotChatsService: { assertOwnedBy: assertOwnedByMock },
      chatHistoryService: { page: pageMock },
    });
  });

  it("returns one page of the user's thread with its cursor", async () => {
    const res = await GET(url('?before=42&turns=10'), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ id: 'm1' }], nextCursor: 7 });
    expect(assertOwnedByMock).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(pageMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHAT_ID }),
      { before: 42, turns: 10 },
      expect.any(Function),
    );
  });

  it('ignores a malformed cursor or size', async () => {
    await GET(url('?before=abc&turns=-3'), params);
    expect(pageMock.mock.calls[0][1]).toEqual({ before: undefined, turns: undefined });
  });

  it("imports through the thread's pinned agent's checkpoint when asked", async () => {
    await GET(url(), params);
    const load = pageMock.mock.calls[0][2] as () => Promise<unknown>;

    await load();

    expect(getChatAgentGraphMock).toHaveBeenCalledWith('dikti');
    expect(getMessagesMock).toHaveBeenCalledWith(CHAT_ID);
  });

  it("403s on another user's thread", async () => {
    assertOwnedByMock.mockRejectedValue(new CopilotChatForbiddenError(CHAT_ID));
    expect((await GET(url(), params)).status).toBe(403);
    expect(pageMock).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(url(), params)).status).toBe(401);
  });
});
