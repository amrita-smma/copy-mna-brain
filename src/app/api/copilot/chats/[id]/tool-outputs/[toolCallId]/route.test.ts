import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, assertOwnedByMock, toolOutputMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  assertOwnedByMock: vi.fn(),
  toolOutputMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from '@/lib/services/copilotChatsService';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const req = new NextRequest(`http://localhost/api/copilot/chats/${CHAT_ID}/tool-outputs/toolu_1`);
const params = { params: Promise.resolve({ id: CHAT_ID, toolCallId: 'toolu_1' }) };

describe('GET /api/copilot/chats/[id]/tool-outputs/[toolCallId]', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    assertOwnedByMock.mockReset().mockResolvedValue({ id: CHAT_ID });
    toolOutputMock.mockReset().mockResolvedValue('the whole output');
    createContainerMock.mockReset().mockReturnValue({
      copilotChatsService: { assertOwnedBy: assertOwnedByMock },
      chatHistoryService: { toolOutput: toolOutputMock },
    });
  });

  it("returns the stored output of one tool call in the user's thread", async () => {
    const res = await GET(req, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { toolCallId: 'toolu_1', content: 'the whole output' } });
    expect(assertOwnedByMock).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(toolOutputMock).toHaveBeenCalledWith(CHAT_ID, 'toolu_1');
  });

  it('404s when no stored reply holds the call (a turn still running)', async () => {
    toolOutputMock.mockResolvedValue(null);
    expect((await GET(req, params)).status).toBe(404);
  });

  it("403s on another user's thread and 404s on an unknown one, without reading", async () => {
    assertOwnedByMock.mockRejectedValueOnce(new CopilotChatForbiddenError(CHAT_ID));
    expect((await GET(req, params)).status).toBe(403);
    assertOwnedByMock.mockRejectedValueOnce(new CopilotChatNotFoundError(CHAT_ID));
    expect((await GET(req, params)).status).toBe(404);
    expect(toolOutputMock).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(req, params)).status).toBe(401);
  });
});
