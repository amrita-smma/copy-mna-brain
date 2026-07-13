import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundValuationRepository } from './fundValuationRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('FundValuationRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: FundValuationRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FundValuationRepository(db as never, 'workspace-1');
  });

  it('findByFundId returns every snapshot for the fund, most recent first', async () => {
    const rows = [{ id: 'fv1', fund_id: 'f1', as_of_date: '2026-06-30' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const result = await repo.findByFundId('f1');
    expect(result).toEqual(rows);
    // One where() for the workspace-fund-ids subquery, one for the outer query.
    expect(db.where).toHaveBeenCalledTimes(2);
  });

  it('findLatestByFundId returns the most recent snapshot', async () => {
    const row = { id: 'fv2', fund_id: 'f1', as_of_date: '2026-06-30' };
    db.limit.mockResolvedValueOnce([row]);
    const result = await repo.findLatestByFundId('f1');
    expect(result).toEqual(row);
  });

  it('findLatestByFundId returns undefined when there are no snapshots yet', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findLatestByFundId('f1');
    expect(result).toBeUndefined();
  });

  it('findById returns undefined when no snapshot matches', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('missing');
    expect(result).toBeUndefined();
  });

  it('insert writes the row as-is, including its currency', async () => {
    const row = { id: 'fv1', fund_id: 'f1', currency: 'USD' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({
      fund_id: 'f1',
      as_of_date: '2026-06-30',
      currency: 'USD',
    } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD' }));
  });

  it('upsert conflicts on (fund_id, as_of_date) and returns the resulting row', async () => {
    const row = { id: 'fv1', fund_id: 'f1', as_of_date: '2026-06-30', currency: 'USD' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.upsert({
      fund_id: 'f1',
      as_of_date: '2026-06-30',
      currency: 'USD',
    } as never);
    expect(result).toEqual(row);
    expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({ currency: 'USD' }),
      }),
    );
  });

  it('update sets the given fields and returns the updated row', async () => {
    const row = { id: 'fv1', dpi: 1.2 };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('fv1', { dpi: 1.2 });
    expect(result).toEqual(row);
  });

  it('delete removes the snapshot by id', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('fv1');
    expect(db.delete).toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot see another workspace\'s snapshot', async () => {
      const dbA = makeDb();
      const dbB = makeDb();
      const repoA = new FundValuationRepository(dbA as never, 'workspace-a');
      const repoB = new FundValuationRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'fv1', fund_id: 'f1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findById('fv1')).toBeDefined();
      expect(await repoB.findById('fv1')).toBeUndefined();
    });
  });
});
