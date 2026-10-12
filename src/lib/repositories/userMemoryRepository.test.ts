import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MEMORY_COLLECTION, UserMemoryRepository } from './userMemoryRepository';

/**
 * Renders the literal SQL text of a Drizzle `SQL` — the `StringChunk`s only,
 * recursing into nested fragments so a clause built by `sql.join` or a ternary
 * still shows up. Bound values are deliberately left out: this asserts the
 * shape of the statement, never the data in it.
 */
function sqlText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const chunk = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(sqlText).join('');
  if (Array.isArray(chunk.value)) return chunk.value.join('');
  return '';
}

/**
 * Every bound value in a Drizzle `SQL`, in order. Drizzle keeps interpolated
 * values as bare chunks alongside the `StringChunk`s that carry the SQL text,
 * so anything that is not a `StringChunk` or a nested fragment is a parameter.
 */
function sqlParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node !== null && typeof node === 'object') {
    const chunk = node as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(chunk.queryChunks)) {
      chunk.queryChunks.forEach((child) => sqlParams(child, out));
      return out;
    }
    if (Array.isArray(chunk.value)) return out;
  }
  if (node !== undefined) out.push(node);
  return out;
}

const WORKSPACE = 'ws-1';
const USER = 'user-1';
const embedding = Array.from({ length: 1024 }, () => 0.01);

/**
 * A `db` double covering the builder chains the repository uses. `select` and
 * `delete` resolve to `rows`; `execute` resolves to `{ rows }`.
 */
function makeDb(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: vi.fn(self),
    where: vi.fn(self),
    orderBy: vi.fn(self),
    set: vi.fn(self),
    values: vi.fn(() => Promise.resolve(undefined)),
    limit: vi.fn(self),
    offset: vi.fn(() => Promise.resolve(rows)),
    returning: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  });
  return {
    chain,
    select: vi.fn(self),
    insert: vi.fn(self),
    update: vi.fn(self),
    delete: vi.fn(self),
    execute: vi.fn((_query: unknown) => Promise.resolve({ rows })),
  };
}

let db: ReturnType<typeof makeDb>;
let repo: UserMemoryRepository;

beforeEach(() => {
  db = makeDb();
  repo = new UserMemoryRepository(db as never, WORKSPACE);
});

describe('UserMemoryRepository.insertMany', () => {
  it('returns without hitting the DB when there is nothing to insert', async () => {
    await repo.insertMany(USER, MEMORY_COLLECTION, []);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('stamps the user and the origin workspace onto every row in one statement', async () => {
    await repo.insertMany(USER, MEMORY_COLLECTION, [
      { id: 'm1', memory: 'Prefers Indonesian coal deals', embedding, payload: { data: 'a' } },
      { id: 'm2', memory: 'Works with the Jakarta team', embedding, payload: { data: 'b' } },
    ]);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const values = (db.chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      id: 'm1',
      user_id: USER,
      // Provenance only — recorded, never filtered on.
      workspace_id: WORKSPACE,
      collection: MEMORY_COLLECTION,
      memory: 'Prefers Indonesian coal deals',
    });
    expect(values[1]).toMatchObject({ id: 'm2', workspace_id: WORKSPACE, user_id: USER });
  });

  it('rejects a vector that is not the store dimension', async () => {
    await expect(
      repo.insertMany(USER, MEMORY_COLLECTION, [
        { id: 'm1', memory: 'x', embedding: [0.1, 0.2], payload: {} },
      ]),
    ).rejects.toThrow('1024 dimensions');
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('UserMemoryRepository.searchByEmbedding', () => {
  it('orders by cosine distance and scopes to the user and collection', async () => {
    db.execute.mockResolvedValueOnce({
      rows: [
        {
          id: 'm1',
          memory: 'Prefers Indonesian coal deals',
          collection: MEMORY_COLLECTION,
          payload: { data: 'Prefers Indonesian coal deals' },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          distance: '0.12',
        },
      ],
    });

    const hits = await repo.searchByEmbedding(USER, MEMORY_COLLECTION, embedding, 5);

    expect(hits).toEqual([
      expect.objectContaining({ id: 'm1', distance: 0.12 }),
    ]);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain('<=>');
    expect(text).toContain('ORDER BY distance ASC');
    const params = sqlParams(db.execute.mock.calls[0][0]);
    expect(params).toContain(USER);
    expect(params).toContain(MEMORY_COLLECTION);
    // A memory belongs to the person, so recall is NOT narrowed by workspace.
    expect(sqlText(db.execute.mock.calls[0][0])).not.toContain('workspace_id');
    expect(params).not.toContain(WORKSPACE);
  });

  it('recalls a memory formed in another workspace', async () => {
    db.execute.mockResolvedValueOnce({
      rows: [
        {
          id: 'm1',
          memory: 'Covers Indonesian coal',
          collection: MEMORY_COLLECTION,
          // Formed somewhere else entirely.
          payload: { data: 'Covers Indonesian coal' },
          created_at: 'now',
          updated_at: 'now',
          distance: 0.1,
        },
      ],
    });

    const hits = await repo.searchByEmbedding(USER, MEMORY_COLLECTION, embedding, 5);
    expect(hits).toHaveLength(1);
  });

  it('binds extra payload filters rather than concatenating them into the SQL', async () => {
    await repo.searchByEmbedding(USER, MEMORY_COLLECTION, embedding, 5, {
      agent_id: "copilot'; DROP TABLE user_memories; --",
    });

    const call = db.execute.mock.calls[0][0];
    // The key and the value are both bound, so neither reaches the SQL text.
    expect(sqlText(call)).toContain('payload->>');
    expect(sqlText(call)).not.toContain('DROP TABLE');
    expect(sqlText(call)).not.toContain('agent_id');
    expect(sqlParams(call)).toContain('agent_id');
    expect(sqlParams(call)).toContain("copilot'; DROP TABLE user_memories; --");
  });

  it('caps topK so a caller cannot ask for the whole table', async () => {
    await repo.searchByEmbedding(USER, MEMORY_COLLECTION, embedding, 10_000);
    expect(sqlParams(db.execute.mock.calls[0][0])).toContain(500);
  });

  it('rejects a query vector that is not the store dimension', async () => {
    await expect(
      repo.searchByEmbedding(USER, MEMORY_COLLECTION, [0.1], 5),
    ).rejects.toThrow('1024 dimensions');
  });

  it('rejects a non-finite component instead of emitting an invalid literal', async () => {
    const broken = [...embedding];
    broken[7] = Number.NaN;

    await expect(
      repo.searchByEmbedding(USER, MEMORY_COLLECTION, broken, 5),
    ).rejects.toThrow('finite numbers');
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('UserMemoryRepository.list', () => {
  it('does not narrow the listing by workspace', async () => {
    await repo.list(USER, MEMORY_COLLECTION, 20, { run_id: 'r1' });

    expect(sqlText(db.execute.mock.calls[0][0])).not.toContain('workspace_id');
  });

  it('reads newest first through the builder when there are no payload filters', async () => {
    db = makeDb([
      {
        id: 'm1',
        memory: 'a',
        collection: MEMORY_COLLECTION,
        payload: {},
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ]);
    repo = new UserMemoryRepository(db as never, WORKSPACE);

    const rows = await repo.list(USER, MEMORY_COLLECTION, 20);

    expect(rows).toHaveLength(1);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.chain.orderBy).toHaveBeenCalled();
  });

  it('falls back to a bound raw query when payload filters are present', async () => {
    await repo.list(USER, MEMORY_COLLECTION, 20, { run_id: 'r1' });

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(sqlParams(db.execute.mock.calls[0][0])).toContain('r1');
  });

  it('offsets the builder read so a caller can page past the first page', async () => {
    await repo.list(USER, MEMORY_COLLECTION, 20, {}, 40);

    expect(db.chain.offset).toHaveBeenCalledWith(40);
  });

  it('offsets the raw read too when payload filters are present', async () => {
    await repo.list(USER, MEMORY_COLLECTION, 20, { run_id: 'r1' }, 40);

    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain('OFFSET');
    expect(sqlParams(db.execute.mock.calls[0][0])).toContain(40);
  });
});

describe('UserMemoryRepository.deleteByIds', () => {
  it('returns 0 without hitting the DB when the id list is empty', async () => {
    expect(await repo.deleteByIds(USER, [])).toBe(0);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('reports how many rows the user actually owned', async () => {
    db = makeDb([{ id: 'm1' }]);
    repo = new UserMemoryRepository(db as never, WORKSPACE);

    expect(await repo.deleteByIds(USER, ['m1', 'not-theirs'])).toBe(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe('UserMemoryRepository.deleteAll', () => {
  it('reports how many memories were cleared', async () => {
    db = makeDb([{ id: 'm1' }, { id: 'm2' }]);
    repo = new UserMemoryRepository(db as never, WORKSPACE);

    expect(await repo.deleteAll(USER, MEMORY_COLLECTION)).toBe(2);
  });
});

describe('UserMemoryRepository.findById', () => {
  it('returns null when the row is missing or belongs to another user', async () => {
    expect(await repo.findById(USER, 'm1')).toBeNull();
  });
});
