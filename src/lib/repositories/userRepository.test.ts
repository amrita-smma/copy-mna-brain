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

/**
 * A `db` double for the two preference methods: `select…from…where…limit` and
 * `update…set…where…returning` both resolve to `rows`.
 */
function makePreferenceDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: vi.fn(self),
    set: vi.fn(self),
    where: vi.fn(self),
    limit: vi.fn(() => Promise.resolve(rows)),
    returning: vi.fn(() => Promise.resolve(rows)),
  });
  return { select: vi.fn(self), update: vi.fn(self) };
}

describe('UserRepository.findCopilotMemoryEnabled', () => {
  it('reads the stored preference', async () => {
    const repo = new UserRepository(makePreferenceDb([{ enabled: false }]) as never);

    expect(await repo.findCopilotMemoryEnabled('u1')).toBe(false);
  });

  it('fails OPEN for an unknown id', async () => {
    // Read on the chat path: a missing row means something is already wrong,
    // and silently disabling memory for everyone is harder to notice than the
    // opposite. See the method's doc comment.
    const repo = new UserRepository(makePreferenceDb([]) as never);

    expect(await repo.findCopilotMemoryEnabled('nobody')).toBe(true);
  });
});

describe('UserRepository.setCopilotMemoryEnabled', () => {
  it('returns the value the database stored, not the one passed in', async () => {
    const repo = new UserRepository(makePreferenceDb([{ enabled: true }]) as never);

    expect(await repo.setCopilotMemoryEnabled('u1', true)).toBe(true);
  });

  it('falls back to the requested value when the update matched no row', async () => {
    const repo = new UserRepository(makePreferenceDb([]) as never);

    expect(await repo.setCopilotMemoryEnabled('nobody', false)).toBe(false);
  });
});

describe('UserRepository.hasDeleteBlockingHistory', () => {
  function makeProbeDb(rows: Array<{ blocked: boolean }>) {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
    return { db: { select: vi.fn().mockReturnValue(selectChain) }, selectChain };
  }

  it('returns true when the probe reports blocking rows', async () => {
    const { db } = makeProbeDb([{ blocked: true }]);
    expect(await new UserRepository(db as never).hasDeleteBlockingHistory('u1')).toBe(true);
  });

  it('returns false when there are none', async () => {
    const { db } = makeProbeDb([{ blocked: false }]);
    expect(await new UserRepository(db as never).hasDeleteBlockingHistory('u1')).toBe(false);
  });

  it('returns false for an unknown id', async () => {
    const { db } = makeProbeDb([]);
    expect(await new UserRepository(db as never).hasDeleteBlockingHistory('nobody')).toBe(false);
  });
});

describe('UserRepository.hardDeleteDeactivated', () => {
  function makeDeleteDb(rows: unknown[]) {
    const deleteChain = {
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue(rows),
    };
    return { db: { delete: vi.fn().mockReturnValue(deleteChain) }, deleteChain };
  }

  it('returns the deleted row', async () => {
    const row = { id: 'u1', name: 'Alice', deactivated_at: '2026-02-01T00:00:00.000Z' };
    const { db, deleteChain } = makeDeleteDb([row]);

    const result = await new UserRepository(db as never).hardDeleteDeactivated('u1');

    expect(result).toEqual(row);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when nothing matched (unknown or still active)', async () => {
    const { db } = makeDeleteDb([]);
    expect(await new UserRepository(db as never).hardDeleteDeactivated('u1')).toBeUndefined();
  });
});
