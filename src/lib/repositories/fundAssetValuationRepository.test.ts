import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundAssetValuationRepository } from './fundAssetValuationRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
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

describe('FundAssetValuationRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: FundAssetValuationRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FundAssetValuationRepository(db as never, 'workspace-1');
  });

  it('findByFundAssetId returns every snapshot for the asset, most recent first', async () => {
    const rows = [{ id: 'v1', fund_asset_id: 'a1', as_of_date: '2026-06-30' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const result = await repo.findByFundAssetId('a1');
    expect(result).toEqual(rows);
    // One where() for the workspace-fund-asset-ids subquery, one for the outer query.
    expect(db.where).toHaveBeenCalledTimes(2);

  });

  it('findLatestByFundAssetId returns the most recent snapshot', async () => {
    const row = { id: 'v2', fund_asset_id: 'a1', as_of_date: '2026-06-30' };
    db.limit.mockResolvedValueOnce([row]);
    const result = await repo.findLatestByFundAssetId('a1');
    expect(result).toEqual(row);
  });

  it('findLatestByFundAssetId returns undefined when there are no snapshots yet', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findLatestByFundAssetId('a1');
    expect(result).toBeUndefined();
  });

  it('findById returns undefined when no snapshot matches', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('missing');
    expect(result).toBeUndefined();
  });

  it('insert writes the row as-is, including its currency', async () => {
    const row = { id: 'v1', fund_asset_id: 'a1', currency: 'IDR' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({
      fund_asset_id: 'a1',
      as_of_date: '2026-06-30',
      currency: 'IDR',
    } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ currency: 'IDR' }));
  });

  it('upsert conflicts on (fund_asset_id, as_of_date) and returns the resulting row', async () => {
    const row = { id: 'v1', fund_asset_id: 'a1', as_of_date: '2026-06-30', currency: 'USD' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.upsert({
      fund_asset_id: 'a1',
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
    const row = { id: 'v1', notes: 'restated' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('v1', { notes: 'restated' });
    expect(result).toEqual(row);
  });

  it('delete removes the snapshot by id', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('v1');
    expect(db.delete).toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot see another workspace\'s snapshot', async () => {
      const dbA = makeDb();
      const dbB = makeDb();
      const repoA = new FundAssetValuationRepository(dbA as never, 'workspace-a');
      const repoB = new FundAssetValuationRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'v1', fund_asset_id: 'a1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findById('v1')).toBeDefined();
      expect(await repoB.findById('v1')).toBeUndefined();
    });
  });
});
