import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hybridSearch, repoCtor, embed } = vi.hoisted(() => ({
  hybridSearch: vi.fn(),
  repoCtor: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({ client: 'db' })) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/repositories', () => ({
  CopilotMessageRepository: class {
    constructor(db: unknown, workspaceId: string) {
      repoCtor(db, workspaceId);
    }
    hybridSearch = hybridSearch;
  },
}));
vi.mock('@/lib/bedrock', () => ({
  BedrockEmbeddingClient: class {
    embed = embed;
  },
}));

import { searchChatHistory } from './search_chat_history';

const config = { configurable: { userId: 'u1', botId: 'scout' } };

describe('search_chat_history', () => {
  beforeEach(() => {
    hybridSearch.mockReset().mockResolvedValue([]);
    repoCtor.mockReset();
    embed.mockReset().mockResolvedValue([0.1]);
  });

  it("searches this bot's thread for the chatting user, by meaning and words, and lists dated hits", async () => {
    hybridSearch.mockResolvedValue([
      { id: 'm1', chat_id: 'c', bot_id: 'scout', bot_name: 'Deal Scout', text: 'Q: Acme?\n\nA: 8x EBITDA', created_at: '2026-09-12T03:00:00Z', score: 0.03 },
    ]);

    const out = (await searchChatHistory.invoke({ query: 'Acme multiple' }, config)) as string;

    expect(repoCtor).toHaveBeenCalledWith({ client: 'db' }, 'ws-1');
    expect(hybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', botId: 'scout', query: 'Acme multiple', embedding: [0.1], limit: 8 }),
    );
    expect(out).toContain('### 2026-09-12 · Deal Scout');
    expect(out).toContain('8x EBITDA');
  });

  it("searches every bot's thread with scope all_bots", async () => {
    await searchChatHistory.invoke({ query: 'x', scope: 'all_bots' }, config);
    expect(hybridSearch.mock.calls[0][0].botId).toBeUndefined();
  });

  it('falls back to full text when embedding fails', async () => {
    embed.mockRejectedValue(new Error('no AWS'));
    await searchChatHistory.invoke({ query: 'x' }, config);
    expect(hybridSearch.mock.calls[0][0].embedding).toBeNull();
  });

  it('refuses to run outside a bot chat', async () => {
    const out = (await searchChatHistory.invoke({ query: 'x' }, { configurable: {} })) as string;
    expect(out).toContain('only runs inside a Copilot bot chat');
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it('says when nothing matches', async () => {
    expect(await searchChatHistory.invoke({ query: 'zzz' }, config)).toBe('No earlier conversation matches "zzz".');
  });
});
