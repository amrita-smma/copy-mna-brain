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
