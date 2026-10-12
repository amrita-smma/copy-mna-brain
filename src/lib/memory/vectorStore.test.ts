import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleMemoryVectorStore } from './vectorStore';

const USER = 'user-1';

const repo = {
  insertMany: vi.fn(),
  searchByEmbedding: vi.fn(),
  keywordSearch: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  deleteByIds: vi.fn(),
  deleteAll: vi.fn(),
};

function makeStore(collectionName = 'memories') {
  return new DrizzleMemoryVectorStore({
    repository: repo as never,
    userId: USER,
    collectionName,
  });
}

beforeEach(() => {
  Object.values(repo).forEach((fn) => fn.mockReset());
  repo.insertMany.mockResolvedValue(undefined);
  repo.searchByEmbedding.mockResolvedValue([]);
  repo.keywordSearch.mockResolvedValue([]);
  repo.findById.mockResolvedValue(null);
  repo.update.mockResolvedValue(undefined);
  repo.list.mockResolvedValue([]);
  repo.deleteByIds.mockResolvedValue(0);
  repo.deleteAll.mockResolvedValue(0);
});

describe('DrizzleMemoryVectorStore constructor', () => {
  it('refuses to build without a repository or a user', () => {
    expect(() => new DrizzleMemoryVectorStore({ userId: USER } as never)).toThrow(
      'UserMemoryRepository',
    );
    expect(
      () => new DrizzleMemoryVectorStore({ repository: repo as never, userId: '' }),
    ).toThrow('userId');
  });
});

describe('DrizzleMemoryVectorStore.insert', () => {
  it('writes every vector in one repository call, keyed on the memory text', async () => {
    await makeStore().insert(
      [[0.1], [0.2]],
      ['m1', 'm2'],
      [{ data: 'Likes coal' }, { data: 'Based in Jakarta' }],
    );

    expect(repo.insertMany).toHaveBeenCalledTimes(1);
    const [userId, collection, rows] = repo.insertMany.mock.calls[0];
    expect(userId).toBe(USER);
    expect(collection).toBe('memories');
    expect(rows).toEqual([
      { id: 'm1', memory: 'Likes coal', embedding: [0.1], payload: { data: 'Likes coal', user_id: USER } },
      {
        id: 'm2',
        memory: 'Based in Jakarta',
        embedding: [0.2],
        payload: { data: 'Based in Jakarta', user_id: USER },
      },
    ]);
  });

  it('stamps the bound user over whatever mem0 put in the payload', async () => {
    await makeStore().insert([[0.1]], ['m1'], [{ data: 'x', user_id: 'someone-else' }]);

    expect(repo.insertMany.mock.calls[0][2][0].payload.user_id).toBe(USER);
  });

  it('rejects mismatched ids, vectors and payloads', async () => {
    await expect(makeStore().insert([[0.1]], ['m1', 'm2'], [{}])).rejects.toThrow('same length');
  });
});

describe('DrizzleMemoryVectorStore.search', () => {
  it('converts cosine distance to the similarity score mem0 expects', async () => {
    repo.searchByEmbedding.mockResolvedValue([
      {
        id: 'm1',
        memory: 'Likes coal',
        collection: 'memories',
        payload: { data: 'Likes coal' },
        created_at: 'now',
        updated_at: 'now',
        distance: 0.25,
      },
    ]);

    const results = await makeStore().search([0.1], 5);

    expect(results).toEqual([
      { id: 'm1', payload: { data: 'Likes coal' }, score: 0.75 },
    ]);
  });

  it('drops user_id from the payload filters so a filter cannot widen the scope', async () => {
    await makeStore().search([0.1], 5, { user_id: 'someone-else', agent_id: 'copilot' });

    expect(repo.searchByEmbedding).toHaveBeenCalledWith(USER, 'memories', [0.1], 5, {
      agent_id: 'copilot',
    });
  });

  it('drops non-string filter values rather than passing an object to the text match', async () => {
    await makeStore().search([0.1], 5, { metadata: { gte: 3 } });

    expect(repo.searchByEmbedding.mock.calls[0][4]).toEqual({});
  });

  it('falls back to the column when a row has no payload.data', async () => {
    repo.searchByEmbedding.mockResolvedValue([
      {
        id: 'm1',
        memory: 'from the column',
        collection: 'memories',
        payload: {},
        created_at: 'now',
        updated_at: 'now',
        distance: 0,
      },
    ]);

    const [result] = await makeStore().search([0.1], 5);
    expect(result.payload.data).toBe('from the column');
  });
});

describe('DrizzleMemoryVectorStore.keywordSearch', () => {
  it('returns null instead of throwing so mem0 degrades to vector-only recall', async () => {
    repo.keywordSearch.mockRejectedValue(new Error('no tsvector'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await makeStore().keywordSearch('coal', 5)).toBeNull();

    spy.mockRestore();
  });

  it('passes the lexical rank through as the score', async () => {
    repo.keywordSearch.mockResolvedValue([
      {
        id: 'm1',
        memory: 'Likes coal',
        collection: 'memories',
        payload: { data: 'Likes coal' },
        created_at: 'now',
        updated_at: 'now',
        distance: 0.4,
        score: 0.6,
      },
    ]);

    const results = await makeStore().keywordSearch('coal', 5);
    expect(results?.[0].score).toBe(0.6);
  });
});

describe('DrizzleMemoryVectorStore.update', () => {
  it('writes the new text, vector and payload under the bound user', async () => {
    await makeStore().update('m1', [0.3], { data: 'Now prefers nickel' });

    expect(repo.update).toHaveBeenCalledWith(USER, 'm1', 'Now prefers nickel', [0.3], {
      data: 'Now prefers nickel',
      user_id: USER,
    });
  });
});

describe('DrizzleMemoryVectorStore.delete / deleteCol', () => {
  it('deletes one memory through the user-scoped repository', async () => {
    await makeStore().delete('m1');
    expect(repo.deleteByIds).toHaveBeenCalledWith(USER, ['m1']);
  });

  it('clears only this user and collection', async () => {
    await makeStore('memories_entities').deleteCol();
    expect(repo.deleteAll).toHaveBeenCalledWith(USER, 'memories_entities');
  });
});

describe('DrizzleMemoryVectorStore.list', () => {
  it('returns mem0 its [records, count] pair', async () => {
    repo.list.mockResolvedValue([
      {
        id: 'm1',
        memory: 'a',
        collection: 'memories',
        payload: { data: 'a' },
        created_at: 'now',
        updated_at: 'now',
      },
    ]);

    const [records, count] = await makeStore().list(undefined, 50);

    expect(records).toEqual([{ id: 'm1', payload: { data: 'a' } }]);
    expect(count).toBe(1);
  });
});

describe('DrizzleMemoryVectorStore entity collection', () => {
  it("keeps mem0's entity index in its own collection", async () => {
    await makeStore('memories_entities').insert([[0.1]], ['e1'], [{ data: 'Acme' }]);
    expect(repo.insertMany.mock.calls[0][1]).toBe('memories_entities');
  });
});
