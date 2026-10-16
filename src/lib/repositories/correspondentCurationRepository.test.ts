import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
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

  it('writes the banker profile fields to both the insert values and the conflict set', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ correspondent_id: 'c1' }]);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.upsert(
      'c1',
      {
        department: 'M&A',
        specialization: 'Semiconductors',
        seniority: 'Managing Director',
        coverage_region: 'Asia Pacific',
        linkedin_url: 'https://linkedin.com/in/jane',
        bio: 'Ex-Lazard.',
      },
      'u1',
    );

    const expected = {
      department: 'M&A',
      specialization: 'Semiconductors',
      seniority: 'Managing Director',
      coverage_region: 'Asia Pacific',
      linkedin_url: 'https://linkedin.com/in/jane',
      bio: 'Ex-Lazard.',
    };
    expect(db.onConflictDoUpdate.mock.calls[0][0].set).toMatchObject(expected);
    expect(db.values.mock.calls[0][0]).toMatchObject({
      correspondent_id: 'c1',
      ...expected,
    });
  });

  it('nulls a profile field that is explicitly cleared', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ correspondent_id: 'c1' }]);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.upsert('c1', { department: null }, 'u1');
    expect(db.onConflictDoUpdate.mock.calls[0][0].set).toHaveProperty(
      'department',
      null,
    );
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

describe('CorrespondentCurationRepository.fillMany', () => {
  it('does nothing for an empty batch', async () => {
    const db = makeDb();
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.fillMany([], 'u1');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('writes every row in one statement, folding repeats of one contact together', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.fillMany(
      [
        { correspondentId: 'c1', edit: { title: 'VP' } },
        { correspondentId: 'c2', edit: { name: 'B' } },
        { correspondentId: 'c1', edit: { phone: '123' } },
      ],
      'u1',
    );
    expect(db.insert).toHaveBeenCalledTimes(1);
    const rows = db.values.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      correspondent_id: 'c1',
      title: 'VP',
      phone: '123',
      name: null,
      edited_by: 'u1',
    });
  });

  it('never clears an existing overlay value with a blank import cell', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new CorrespondentCurationRepository(db as never);
    await repo.fillMany([{ correspondentId: 'c1', edit: { title: 'VP' } }], null);
    const { set } = db.onConflictDoUpdate.mock.calls[0][0];
    expect(new PgDialect().sqlToQuery(set.name).sql).toBe(
      'COALESCE(EXCLUDED.name, correspondent_curation.name)',
    );
  });
});
