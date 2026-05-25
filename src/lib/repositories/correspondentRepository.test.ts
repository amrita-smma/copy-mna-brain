import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorrespondentRepository } from './correspondentRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CorrespondentRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: CorrespondentRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new CorrespondentRepository(db as never);
  });

  it('clears the primary flag before inserting a new primary contact', async () => {
    db.where.mockResolvedValueOnce(undefined); // the clearPrimary update
    db.returning.mockResolvedValueOnce([{ id: 'c1', name: 'X', is_primary: true }]);

    await repo.insert({
      employer_id: 'e1',
      name: 'X',
      is_primary: true,
    });

    expect(db.update).toHaveBeenCalled(); // clearPrimary
    expect(db.insert).toHaveBeenCalled();
  });

  it('does not pre-clear primary when is_primary is false/missing', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'c1', name: 'X' }]);

    await repo.insert({ employer_id: 'e1', name: 'X' });

    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns [] for findByIds with empty input', async () => {
    const out = await repo.findByIds([]);
    expect(out).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks up by (employer_id, email) for dedupe', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'c1', email: 'a@b.com' }]);
    const out = await repo.findByEmployerAndEmail('e1', 'a@b.com');
    expect(out).toEqual({ id: 'c1', email: 'a@b.com' });
  });
});
