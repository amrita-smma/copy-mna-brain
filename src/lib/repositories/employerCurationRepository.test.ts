import { describe, it, expect, vi } from 'vitest';
import { EmployerCurationRepository } from './employerCurationRepository';

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

describe('EmployerCurationRepository.findByEmployerId', () => {
  it('returns the overlay row when present', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([{ employer_id: 'e1', name: 'Custom' }]);
    const repo = new EmployerCurationRepository(db as never);
    expect(await repo.findByEmployerId('e1')).toMatchObject({ name: 'Custom' });
  });

  it('returns null when absent', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([]);
    const repo = new EmployerCurationRepository(db as never);
    expect(await repo.findByEmployerId('e1')).toBeNull();
  });
});

describe('EmployerCurationRepository.findManyByEmployerIds', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new EmployerCurationRepository(db as never);
    expect(await repo.findManyByEmployerIds([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('EmployerCurationRepository.upsert', () => {
  it('writes only the provided fields (editing name does not touch industry)', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ employer_id: 'e1', name: 'Custom' }]);
    const repo = new EmployerCurationRepository(db as never);
    await repo.upsert('e1', { name: 'Custom' }, 'u1');

    const setArg = db.onConflictDoUpdate.mock.calls[0][0].set;
    expect(setArg).toHaveProperty('name');
    expect(setArg).not.toHaveProperty('industry');
    expect(setArg).toHaveProperty('edited_by', 'u1');
  });

  it('allows clearing a single field by passing null (revert to machine value)', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ employer_id: 'e1', name: null }]);
    const repo = new EmployerCurationRepository(db as never);
    await repo.upsert('e1', { name: null }, 'u1');
    const setArg = db.onConflictDoUpdate.mock.calls[0][0].set;
    expect(setArg.name).toBeNull();
  });
});

describe('EmployerCurationRepository.clear', () => {
  it('deletes the whole overlay row', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new EmployerCurationRepository(db as never);
    await repo.clear('e1');
    expect(db.delete).toHaveBeenCalled();
  });
});
