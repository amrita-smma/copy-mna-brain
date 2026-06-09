import { describe, it, expect, vi } from 'vitest';
import { CorrespondentCurationRepository } from './correspondentCurationRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CorrespondentCurationRepository.findByCorrespondentId', () => {
  it('returns the overlay row when present', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([{ correspondent_id: 'c1', title: 'VP' }]);
    const repo = new CorrespondentCurationRepository(db as never);
    expect(await repo.findByCorrespondentId('c1')).toMatchObject({ title: 'VP' });
  });

  it('returns null when absent', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([]);
    const repo = new CorrespondentCurationRepository(db as never);
    expect(await repo.findByCorrespondentId('c1')).toBeNull();
  });
});

describe('CorrespondentCurationRepository.findManyByCorrespondentIds', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new CorrespondentCurationRepository(db as never);
    expect(await repo.findManyByCorrespondentIds([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('CorrespondentCurationRepository.upsert', () => {
  it('writes only the provided fields', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ correspondent_id: 'c1', title: 'VP' }]);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.upsert('c1', { title: 'VP' }, 'u1');

    const setArg = db.onConflictDoUpdate.mock.calls[0][0].set;
    expect(setArg).toHaveProperty('title', 'VP');
    expect(setArg).not.toHaveProperty('name');
    expect(setArg).not.toHaveProperty('phone');
    expect(setArg).toHaveProperty('edited_by', 'u1');
  });

  it('does not accept is_primary (kept on the base table)', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ correspondent_id: 'c1' }]);
    const repo = new CorrespondentCurationRepository(db as never);
    // @ts-expect-error is_primary is intentionally not part of the overlay edit type
    await repo.upsert('c1', { is_primary: true }, 'u1');
    const setArg = db.onConflictDoUpdate.mock.calls[0][0].set;
    expect(setArg).not.toHaveProperty('is_primary');
  });
});

describe('CorrespondentCurationRepository.clear', () => {
  it('deletes the whole overlay row', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.clear('c1');
    expect(db.delete).toHaveBeenCalled();
  });
});
