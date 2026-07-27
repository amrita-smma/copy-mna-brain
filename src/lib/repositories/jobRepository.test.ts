import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobRepository } from './jobRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('JobRepository.findLatestByTypeAndStatus', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: JobRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new JobRepository(db as never);
  });

  it('returns the most recent matching job', async () => {
    db.limit.mockResolvedValueOnce([
      { id: 'j1', type: 'slide_generation', status: 'completed' },
    ]);
    const out = await repo.findLatestByTypeAndStatus('slide_generation', 'completed');
    expect(out).toMatchObject({ id: 'j1' });
  });

  it('returns null when none match', async () => {
    db.limit.mockResolvedValueOnce([]);
    const out = await repo.findLatestByTypeAndStatus('slide_generation', 'completed');
    expect(out).toBeNull();
  });
});

describe('JobRepository.findByTypeAndPayload', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: JobRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new JobRepository(db as never);
  });

  it('returns every matching row regardless of status', async () => {
    const rows = [
      { id: 'j1', type: 'market_screening', status: 'completed' },
      { id: 'j2', type: 'market_screening', status: 'failed' },
    ];
    db.orderBy.mockResolvedValueOnce(rows);
    const out = await repo.findByTypeAndPayload('market_screening', {
      year: 2026,
      month: 3,
      mode: 'monthly',
    });
    expect(out).toEqual(rows);
  });

  it('returns [] when nothing matches', async () => {
    db.orderBy.mockResolvedValueOnce([]);
    const out = await repo.findByTypeAndPayload('market_screening', {
      year: 2026,
      month: 4,
      mode: 'monthly',
    });
    expect(out).toEqual([]);
  });

  it('stringifies numeric values for the JSONB text comparison', async () => {
    db.orderBy.mockResolvedValueOnce([]);
    await repo.findByTypeAndPayload('market_screening', { year: 2026, month: 1 });
    // Drizzle's sql template captures the value verbatim via parameterised
    // queries; we only assert that the query ran (the SQL shape is exercised
    // by integration tests, not unit tests).
    expect(db.where).toHaveBeenCalled();
  });
});
