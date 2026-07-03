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

describe('UserRepository.findByEmails', () => {
  it('normalizes and deduplicates emails before querying', async () => {
    const { db, selectChain } = makeMockDb();
    const rows = [{ id: 'u1', email: 'alice@example.com' }];
    selectChain.where.mockResolvedValueOnce(rows);

    const repo = new UserRepository(db as never);
    const result = await repo.findByEmails([
      ' Alice@Example.com ',
      'alice@example.com',
    ]);

    expect(result).toEqual(rows);
    expect(db.select).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.anything(), email: expect.anything() }),
    );
  });

  it('returns [] without querying for an empty email list', async () => {
    const { db } = makeMockDb();
    const repo = new UserRepository(db as never);

    await expect(repo.findByEmails([])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('UserRepository.findByNames', () => {
  it('normalizes and deduplicates names before querying', async () => {
    const { db, selectChain } = makeMockDb();
    const rows = [{ id: 'u1', name: 'Pat Lee', email: 'pat@x' }];
    selectChain.where.mockResolvedValueOnce(rows);

    const repo = new UserRepository(db as never);
    const result = await repo.findByNames([' Pat Lee ', 'pat lee']);

    expect(result).toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
    const projection = db.select.mock.calls[0][0];
    expect(Object.keys(projection)).toEqual(['id', 'name', 'email']);
  });

  it('returns [] without querying for an empty or blank name list', async () => {
    const { db } = makeMockDb();
    const repo = new UserRepository(db as never);

    await expect(repo.findByNames([])).resolves.toEqual([]);
    await expect(repo.findByNames(['  '])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});
