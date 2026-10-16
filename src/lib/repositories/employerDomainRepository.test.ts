import { describe, it, expect, vi } from 'vitest';
import { EmployerDomainRepository } from './employerDomainRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('EmployerDomainRepository.findByDomain', () => {
  it('lowercases the input and returns the row when present', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([{ domain: 'goldman.com', employer_id: 'e1' }]);
    const repo = new EmployerDomainRepository(db as never);
    const out = await repo.findByDomain('GOLDMAN.COM');
    expect(out).toMatchObject({ domain: 'goldman.com', employer_id: 'e1' });
  });

  it('returns null when absent', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([]);
    const repo = new EmployerDomainRepository(db as never);
    expect(await repo.findByDomain('x.com')).toBeNull();
  });
});

describe('EmployerDomainRepository.findManyByDomains', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new EmployerDomainRepository(db as never);
    expect(await repo.findManyByDomains([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('EmployerDomainRepository.loadMap', () => {
  it('builds a Map of domain → employer_id', async () => {
    const db = makeDb();
    db.from.mockResolvedValueOnce([
      { domain: 'a.com', employer_id: 'e1' },
      { domain: 'b.com', employer_id: 'e2' },
    ]);
    const repo = new EmployerDomainRepository(db as never);
    const map = await repo.loadMap();
    expect(map.get('a.com')).toBe('e1');
    expect(map.get('b.com')).toBe('e2');
    expect(map.size).toBe(2);
  });
});

describe('EmployerDomainRepository.persistMany', () => {
  it('returns [] without hitting DB when input is empty', async () => {
    const db = makeDb();
    const repo = new EmployerDomainRepository(db as never);
    expect(await repo.persistMany([])).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('inserts with ON CONFLICT DO NOTHING and lowercases the domain', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ domain: 'new.com', employer_id: 'e1' }]);
    const repo = new EmployerDomainRepository(db as never);
    const out = await repo.persistMany([{ domain: 'NEW.com', employer_id: 'e1' }]);
    expect(out).toHaveLength(1);
    expect(db.onConflictDoNothing).toHaveBeenCalled();
    expect(db.values).toHaveBeenCalledWith([
      expect.objectContaining({ domain: 'new.com' }),
    ]);
  });
});

describe('EmployerDomainRepository.repoint', () => {
  it('updates the employer_id for a lowercased domain', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new EmployerDomainRepository(db as never);
    await repo.repoint('GOLDMAN.COM', 'e2');
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalled();
  });
});

describe('EmployerDomainRepository.findByEmployerId', () => {
  it("returns the employer's domain rows", async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ domain: 'acme.co.id', employer_id: 'e1' }]);
    const repo = new EmployerDomainRepository(db as never);
    await expect(repo.findByEmployerId('e1')).resolves.toEqual([
      { domain: 'acme.co.id', employer_id: 'e1' },
    ]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
