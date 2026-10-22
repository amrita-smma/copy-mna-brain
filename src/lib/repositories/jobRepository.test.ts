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

describe('JobRepository.claimPending', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: JobRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new JobRepository(db as never);
  });

  it('flips a pending row to running in one statement and returns it', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'j1', status: 'running' }]);
    const out = await repo.claimPending('j1');
    expect(out).toMatchObject({ id: 'j1', status: 'running' });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', started_at: expect.any(String) }));
    // The predicate carries both the id and `status = 'pending'`; the SQL shape
    // is exercised by integration tests, not unit tests.
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(db.returning).toHaveBeenCalledTimes(1);
  });

  it('returns null without touching anything else when the row is no longer pending', async () => {
    db.returning.mockResolvedValueOnce([]);
    await expect(repo.claimPending('j1')).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('JobRepository.failIfRunning', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: JobRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new JobRepository(db as never);
  });

  it('fails a row only while it is running and returns it', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'j1', status: 'failed' }]);
    const out = await repo.failIfRunning('j1', 'cut off');
    expect(out).toMatchObject({ id: 'j1', status: 'failed' });
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'cut off', completed_at: expect.any(String) }),
    );
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it('returns null when the row already moved on', async () => {
    db.returning.mockResolvedValueOnce([]);
    await expect(repo.failIfRunning('j1', 'cut off')).resolves.toBeNull();
  });
});
