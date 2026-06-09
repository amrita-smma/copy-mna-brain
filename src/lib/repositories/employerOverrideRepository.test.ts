import { describe, it, expect, vi } from 'vitest';
import { EmployerOverrideRepository } from './employerOverrideRepository';

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

describe('EmployerOverrideRepository.findByDomain', () => {
  it('lowercases input and returns the row', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([{ domain: 'x.com', employer_name: 'X' }]);
    const repo = new EmployerOverrideRepository(db as never);
    expect(await repo.findByDomain('X.COM')).toMatchObject({ domain: 'x.com' });
  });

  it('returns null when absent', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([]);
    const repo = new EmployerOverrideRepository(db as never);
    expect(await repo.findByDomain('x.com')).toBeNull();
  });
});

describe('EmployerOverrideRepository.findManyByDomains', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new EmployerOverrideRepository(db as never);
    expect(await repo.findManyByDomains([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('EmployerOverrideRepository.listInternalDomains', () => {
  it('returns the domains flagged internal', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ domain: 'us.com' }, { domain: 'us2.com' }]);
    const repo = new EmployerOverrideRepository(db as never);
    expect(await repo.listInternalDomains()).toEqual(['us.com', 'us2.com']);
  });
});

describe('EmployerOverrideRepository.listExcludedDomains', () => {
  it('returns the domains flagged excluded', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ domain: 'gmail.com' }, { domain: 'yahoo.com' }]);
    const repo = new EmployerOverrideRepository(db as never);
    expect(await repo.listExcludedDomains()).toEqual(['gmail.com', 'yahoo.com']);
  });
});

describe('EmployerOverrideRepository.upsert', () => {
  it('lowercases the domain and upserts with ON CONFLICT DO UPDATE', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ domain: 'x.com', employer_name: 'X' }]);
    const repo = new EmployerOverrideRepository(db as never);
    const out = await repo.upsert({
      domain: 'X.COM',
      employer_name: 'X',
      internal: false,
    });
    expect(out).toMatchObject({ domain: 'x.com' });
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'x.com' }),
    );
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });
});

describe('EmployerOverrideRepository.delete', () => {
  it('deletes by lowercased domain', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new EmployerOverrideRepository(db as never);
    await repo.delete('X.COM');
    expect(db.delete).toHaveBeenCalled();
  });
});
