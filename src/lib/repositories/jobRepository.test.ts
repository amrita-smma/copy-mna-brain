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
      { id: 'j1', type: 'vault_export', status: 'completed' },
    ]);
    const out = await repo.findLatestByTypeAndStatus('vault_export', 'completed');
    expect(out).toMatchObject({ id: 'j1' });
  });

  it('returns null when none match', async () => {
    db.limit.mockResolvedValueOnce([]);
    const out = await repo.findLatestByTypeAndStatus('vault_export', 'completed');
    expect(out).toBeNull();
  });
});
