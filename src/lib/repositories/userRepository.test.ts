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

  /** Bound values on a Drizzle `eq` / `and` SQL fragment (nested queryChunks). */
  function boundValues(clause: unknown): unknown[] {
    const values: unknown[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      if ('encoder' in rec && 'value' in rec) values.push(rec.value);
      if (Array.isArray(rec.queryChunks)) rec.queryChunks.forEach(walk);
    };
    walk(clause);
    return values;
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

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(boundValues(selectChain.where.mock.calls[0][0])).toContain('ws-1');
  });

  it('scopes to the workspace it is given', async () => {
    const { db, selectChain } = makeJoinMockDb();
    selectChain.orderBy.mockResolvedValueOnce([]);

    const repo = new UserRepository(db as never);
    await repo.findAllInWorkspace('ws-other');

    expect(boundValues(selectChain.where.mock.calls[0][0])).toContain('ws-other');
  });
});

describe('UserRepository.findAll', () => {
  it('filters out deactivated users', async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn(),
    };
    const db = { select: vi.fn().mockReturnValue(selectChain) };
    selectChain.orderBy.mockResolvedValueOnce([]);

    const repo = new UserRepository(db as never);
    await repo.findAll();

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
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

describe('UserRepository.findAllIncludingDeactivated', () => {
  it('returns every row without a deactivated_at filter', async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
      orderBy: vi.fn(),
    };
    const db = { select: vi.fn().mockReturnValue(selectChain) };
    const rows = [
      { id: 'u1', name: 'Alice', deactivated_at: null },
      { id: 'u2', name: 'Bob', deactivated_at: '2026-02-01T00:00:00.000Z' },
    ];
    selectChain.orderBy.mockResolvedValueOnce(rows);

    const repo = new UserRepository(db as never);
    const result = await repo.findAllIncludingDeactivated();

    expect(result).toEqual(rows);
    expect(selectChain.where).not.toHaveBeenCalled();
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
  });
});

describe('UserRepository.update / deactivate / reactivate', () => {
  interface UpdateMockDb {
    update: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    returning: ReturnType<typeof vi.fn>;
  }

  function makeUpdateMockDb(): UpdateMockDb {
    return {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    };
  }

  it('update returns the updated row', async () => {
    const db = makeUpdateMockDb();
    const updated = { id: 'u1', name: 'Alicia', email: 'new@x.com' };
    db.returning.mockResolvedValueOnce([updated]);

    const repo = new UserRepository(db as never);
    const result = await repo.update('u1', { name: 'Alicia' });

    expect(result).toEqual(updated);
    expect(db.set).toHaveBeenCalledWith({ name: 'Alicia' });
  });

  it('deactivate stamps deactivated_at and returns the row', async () => {
    const db = makeUpdateMockDb();
    const deactivated = { id: 'u1', deactivated_at: '2026-02-01T00:00:00.000Z' };
    db.returning.mockResolvedValueOnce([deactivated]);

    const repo = new UserRepository(db as never);
    const result = await repo.deactivate('u1');

    expect(result).toEqual(deactivated);
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ deactivated_at: expect.anything(), updated_at: expect.anything() }),
    );
  });

  it('deactivate returns undefined when the user is already deactivated', async () => {
    const db = makeUpdateMockDb();
    db.returning.mockResolvedValueOnce([]);

    const repo = new UserRepository(db as never);
    const result = await repo.deactivate('u1');

    expect(result).toBeUndefined();
  });

  it('reactivate clears deactivated_at', async () => {
    const db = makeUpdateMockDb();
    const reactivated = { id: 'u1', deactivated_at: null };
    db.returning.mockResolvedValueOnce([reactivated]);

    const repo = new UserRepository(db as never);
    const result = await repo.reactivate('u1');

    expect(result).toEqual(reactivated);
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ deactivated_at: null, updated_at: expect.anything() }),
    );
  });
});
