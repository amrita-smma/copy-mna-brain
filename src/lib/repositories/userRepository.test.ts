import { describe, it, expect, vi } from 'vitest';
import { UserRepository } from './userRepository';

function makeMockDb() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
  };
  const db = {
    select: vi.fn().mockReturnValue(selectChain),
  };
  return { db, selectChain };
}

describe('UserRepository.findAllInWorkspace', () => {
  function makeJoinMockDb() {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn(),
    };
    const db = {
      select: vi.fn().mockReturnValue(selectChain),
    };
    return { db, selectChain };
  }

  /**
   * `eq(col, value)` compiles to queryChunks of StringChunk / Column /
   * StringChunk / Param / StringChunk. Pull out the compared column name and
   * the bound value so we can assert on the filter itself — the chunks hold
   * circular table refs, so they can't just be JSON-stringified. The Param is
   * the only chunk carrying an `encoder`; StringChunks also have a `value`.
   */
  function readEq(clause: { queryChunks: unknown[] }) {
    const chunks = clause.queryChunks as Array<Record<string, unknown>>;
    const column = chunks.find((c) => typeof c?.name === 'string');
    const param = chunks.find((c) => c && 'encoder' in c);
    return { column: column?.name as string | undefined, value: param?.value };
  }

  it('joins user_workspaces and filters on the given workspace', async () => {
    const { db, selectChain } = makeJoinMockDb();
    const rows = [{ id: 'u1', name: 'Alice', email: 'alice@x', role: 'admin' }];
    selectChain.orderBy.mockResolvedValueOnce(rows);

    const repo = new UserRepository(db as never);
    const result = await repo.findAllInWorkspace('ws-1');

    expect(result).toEqual(rows);
    expect(selectChain.innerJoin).toHaveBeenCalledTimes(1);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
    // Same projection as findAll — no password or other user columns leak.
    expect(Object.keys(db.select.mock.calls[0][0])).toEqual(['id', 'name', 'email', 'role']);

    // The workspace id must be the actual filter, not just "a where clause".
    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(readEq(selectChain.where.mock.calls[0][0])).toEqual({
      column: 'workspace_id',
      value: 'ws-1',
    });
  });

  it('scopes to the workspace it is given', async () => {
    const { db, selectChain } = makeJoinMockDb();
    selectChain.orderBy.mockResolvedValueOnce([]);

    const repo = new UserRepository(db as never);
    await repo.findAllInWorkspace('ws-other');

    expect(readEq(selectChain.where.mock.calls[0][0]).value).toBe('ws-other');
  });
});

describe('UserRepository.findByIds', () => {
  it('returns [] without hitting the DB when the id list is empty', async () => {
    const { db } = makeMockDb();
    const repo = new UserRepository(db as never);

    const result = await repo.findByIds([]);

    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('selects id/name/email for the given ids', async () => {
    const { db, selectChain } = makeMockDb();
    const rows = [
      { id: 'u1', name: 'Alice', email: 'alice@x' },
      { id: 'u2', name: 'Bob', email: 'bob@x' },
    ];
    selectChain.where.mockResolvedValueOnce(rows);

    const repo = new UserRepository(db as never);
    const result = await repo.findByIds(['u1', 'u2']);

    expect(result).toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
    // The select projection should pick exactly id/name/email — no password.
    const projection = db.select.mock.calls[0][0];
    expect(Object.keys(projection)).toEqual(['id', 'name', 'email']);
  });
});

describe('UserRepository.findById', () => {
  function makeLimitMockDb() {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };
    const db = {
      select: vi.fn().mockReturnValue(selectChain),
    };
    return { db, selectChain };
  }

  it('returns the user row when found', async () => {
    const { db, selectChain } = makeLimitMockDb();
    const row = { id: 'u1', name: 'Alice', is_superadmin: true };
    selectChain.limit.mockResolvedValueOnce([row]);

    const repo = new UserRepository(db as never);
    const result = await repo.findById('u1');

    expect(result).toEqual(row);
  });

  it('returns null when no user matches', async () => {
    const { db, selectChain } = makeLimitMockDb();
    selectChain.limit.mockResolvedValueOnce([]);

    const repo = new UserRepository(db as never);
    const result = await repo.findById('missing');

    expect(result).toBeNull();
  });
});
