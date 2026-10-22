import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({ findById: vi.fn(), setEmbedding: vi.fn(), ctor: vi.fn() }));

vi.mock('@/lib/repositories', () => ({
  CopilotMessageRepository: class {
    constructor(db: unknown, workspaceId: string) {
      repo.ctor(db, workspaceId);
    }
    findById = repo.findById;
    setEmbedding = repo.setEmbedding;
  },
}));
vi.mock('@/lib/bedrock', () => ({ BedrockEmbeddingClient: class {} }));

import { runChatMessageEmbedding } from './chatMessageEmbedding';

describe('runChatMessageEmbedding', () => {
  beforeEach(() => {
    for (const fn of Object.values(repo)) fn.mockReset();
  });

  it("embeds each stored exchange's text in the job's workspace", async () => {
    repo.findById.mockImplementation(async (id: string) => ({ id, text: `Q/A ${id}` }));
    const embed = vi.fn(async () => [0.5]);

    const result = await runChatMessageEmbedding({
      db: {} as never,
      workspaceId: 'ws-1',
      messageIds: ['m1', 'm2'],
      embedder: { embed },
    });

    expect(repo.ctor).toHaveBeenCalledWith({}, 'ws-1');
    expect(embed).toHaveBeenCalledWith('Q/A m1');
    expect(repo.setEmbedding).toHaveBeenCalledWith('m2', [0.5]);
    expect(result).toEqual({ embedded: 2, skipped: 0 });
  });

  it('skips missing or empty rows and keeps going past an embedding failure', async () => {
    repo.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm2', text: '  ' })
      .mockResolvedValueOnce({ id: 'm3', text: 'boom' })
      .mockResolvedValueOnce({ id: 'm4', text: 'ok' });
    const embed = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValueOnce([1]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runChatMessageEmbedding({
      db: {} as never,
      workspaceId: 'ws-1',
      messageIds: ['m1', 'm2', 'm3', 'm4'],
      embedder: { embed },
    });

    expect(result).toEqual({ embedded: 1, skipped: 3 });
    expect(repo.setEmbedding).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
