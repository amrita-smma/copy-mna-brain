import { describe, it, expect, vi } from 'vitest';
import { RawEmailRepository } from './rawEmailRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ count: 0 }]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
}

describe('RawEmailRepository.insertBatch', () => {
  it('returns [] without hitting the DB when input is empty', async () => {
    const db = makeDb();
    const repo = new RawEmailRepository(db as never);
    const out = await repo.insertBatch([]);
    expect(out).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns only the rows the DB confirmed inserted', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'r1', message_id: 'm1' },
      // Second input row was a dupe — DB returns only the first
    ]);
    const repo = new RawEmailRepository(db as never);
    const out = await repo.insertBatch([
      {
        file_id: 'f1',
        custodian_email: 'a@b.com',
        message_id: 'm1',
      } as never,
      {
        file_id: 'f1',
        custodian_email: 'a@b.com',
        message_id: 'm2',
      } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'r1', message_id: 'm1' });
    expect(db.onConflictDoNothing).toHaveBeenCalled();
  });
});

describe('RawEmailRepository.countByFileId', () => {
  it('returns the count from the row', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ count: 42 }]);
    const repo = new RawEmailRepository(db as never);
    expect(await repo.countByFileId('f1')).toBe(42);
  });

  it('returns 0 when the count row is missing', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([]);
    const repo = new RawEmailRepository(db as never);
    expect(await repo.countByFileId('f-missing')).toBe(0);
  });
});
