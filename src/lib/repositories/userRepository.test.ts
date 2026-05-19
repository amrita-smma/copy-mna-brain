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
