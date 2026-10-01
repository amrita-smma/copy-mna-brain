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
import { HumanMessage } from '@langchain/core/messages';
import {
  INSIGHT_SELECTION_KWARG,
  INSIGHT_SELECTION_PART_TYPE,
  formatInsightSelectionBlock,
} from '@/lib/insights/selectionAttachment';

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

  it('rebuilds an insight selection as a chip and shows only the user words (MB-583)', async () => {
    assertOwnedByMock.mockResolvedValue({ id: CHAT_ID, agent_key: null });
    const selection = {
      insightId: '00000000-0000-0000-0000-00000000e101',
      insightName: 'Weekly Weather Forecast',
      sections: [{ path: [0, 0], tags: ['div', 'h1'] }],
    };
    getMessagesMock.mockResolvedValue([
      new HumanMessage({
        id: 'h1',
        content: [
          { type: 'text', text: formatInsightSelectionBlock(selection) },
          { type: 'text', text: 'HERE YOU GO' },
        ],
        additional_kwargs: { [INSIGHT_SELECTION_KWARG]: selection },
      }),
    ]);

    const res = await GET(new NextRequest(`http://localhost/api/copilot/chats/${CHAT_ID}/messages`), {
      params: Promise.resolve({ id: CHAT_ID }),
    });
    const { messages } = await res.json();

    expect(messages).toEqual([
      {
        id: 'h1',
        role: 'user',
        parts: [
          { type: INSIGHT_SELECTION_PART_TYPE, data: selection },
          { type: 'text', text: 'HERE YOU GO' },
        ],
      },
    ]);
  });
});
