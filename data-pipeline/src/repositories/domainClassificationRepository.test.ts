import { describe, it, expect, vi } from 'vitest';
import { DomainClassificationRepository } from './domainClassificationRepository';

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
  };
}

describe('DomainClassificationRepository.findByDomain', () => {
  it('lowercases the input and returns the row when present', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([
      { domain: 'goldman.com', industry: 'Banking' },
    ]);
    const repo = new DomainClassificationRepository(db as never);
    const out = await repo.findByDomain('GOLDMAN.COM');
    expect(out).toMatchObject({ domain: 'goldman.com' });
  });

  it('returns null when absent', async () => {
    const db = makeDb();
    db.where.mockReturnThis();
    db.limit.mockResolvedValueOnce([]);
    const repo = new DomainClassificationRepository(db as never);
    expect(await repo.findByDomain('x.com')).toBeNull();
  });
});

describe('DomainClassificationRepository.findManyByDomains', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new DomainClassificationRepository(db as never);
    expect(await repo.findManyByDomains([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('DomainClassificationRepository.listUnknownDomains', () => {
  it('returns only domains not present in the classification table', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ domain: 'known.com' }]);
    const repo = new DomainClassificationRepository(db as never);
    const out = await repo.listUnknownDomains(['known.com', 'new.com', 'fresh.io']);
    expect(out.sort()).toEqual(['fresh.io', 'new.com']);
  });

  it('lowercases input before comparison', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ domain: 'known.com' }]);
    const repo = new DomainClassificationRepository(db as never);
    expect(await repo.listUnknownDomains(['KNOWN.com', 'NEW.com'])).toEqual([
      'new.com',
    ]);
  });

  it('returns [] for empty input', async () => {
    const db = makeDb();
    const repo = new DomainClassificationRepository(db as never);
    expect(await repo.listUnknownDomains([])).toEqual([]);
  });
});

describe('DomainClassificationRepository.upsertBatch', () => {
  it('returns [] without hitting DB when input is empty', async () => {
    const db = makeDb();
    const repo = new DomainClassificationRepository(db as never);
    expect(await repo.upsertBatch([])).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('inserts the rows with ON CONFLICT DO UPDATE', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ domain: 'x.com' }]);
    const repo = new DomainClassificationRepository(db as never);
    const out = await repo.upsertBatch([
      {
        domain: 'x.com',
        industry: 'Tech',
        confidence: 'high',
        source: 'llm',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });
});
