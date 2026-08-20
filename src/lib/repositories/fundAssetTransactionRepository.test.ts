import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundAssetTransactionRepository } from './fundAssetTransactionRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('FundAssetTransactionRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: FundAssetTransactionRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FundAssetTransactionRepository(db as never, 'workspace-1');
  });

  it('findByFundAssetId returns the full ledger for the asset', async () => {
    const rows = [{ id: 't1', fund_asset_id: 'a1', txn_type: 'contribution' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const result = await repo.findByFundAssetId('a1');
    expect(result).toEqual(rows);
    // One where() for the workspace-fund-asset-ids subquery, one for the outer query.
    expect(db.where).toHaveBeenCalledTimes(2);

  });

  it('findById returns undefined when no transaction matches', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('missing');
    expect(result).toBeUndefined();
  });

  it('insert writes the row as-is, including its txn_type', async () => {
    const row = { id: 't1', fund_asset_id: 'a1', txn_type: 'divestment' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({
      fund_asset_id: 'a1',
      txn_date: '2026-07-08',
      txn_type: 'divestment',
    } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ txn_type: 'divestment' }),
    );
  });

  it('update sets the given fields and returns the updated row', async () => {
    const row = { id: 't1', notes: 'corrected amount' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('t1', { notes: 'corrected amount' });
    expect(result).toEqual(row);
  });

  it('delete removes the transaction by id', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('t1');
    expect(db.delete).toHaveBeenCalled();
  });

  it('findBySourceDivestmentTxnId returns the linked cash movement', async () => {
    const row = { id: 'm1', fund_asset_id: 'cash-1', source_divestment_txn_id: 'sale-1' };
    db.limit.mockResolvedValueOnce([row]);
    const result = await repo.findBySourceDivestmentTxnId('sale-1');
    expect(result).toEqual(row);
  });

  it('deleteBySourceDivestmentTxnId deletes the linked cash movement', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.deleteBySourceDivestmentTxnId('sale-1');
    expect(db.delete).toHaveBeenCalled();
  });

  it('upsertLinkedCashMovement inserts when no movement exists yet', async () => {
    db.limit.mockResolvedValueOnce([]); // findBySourceDivestmentTxnId finds nothing
    const row = { id: 'm1', fund_asset_id: 'cash-1', source_divestment_txn_id: 'sale-1', value_amount: 300000 };
    db.returning.mockResolvedValueOnce([row]);

    const result = await repo.upsertLinkedCashMovement({
      fund_asset_id: 'cash-1',
      fund_id: 'fund-1',
      source_divestment_txn_id: 'sale-1',
      txn_date: '2026-07-08',
      txn_type: 'internal_transfer',
      value_amount: 300000,
    } as never);

    expect(result).toEqual(row);
    expect(db.insert).toHaveBeenCalled();
  });

  it('upsertLinkedCashMovement updates when movement already exists', async () => {
    const existing = { id: 'm1', fund_asset_id: 'cash-1', source_divestment_txn_id: 'sale-1', value_amount: 300000 };
    db.limit.mockResolvedValueOnce([existing]); // findBySourceDivestmentTxnId finds existing
    const updated = { ...existing, value_amount: 320000 };
    db.returning.mockResolvedValueOnce([updated]);

    const result = await repo.upsertLinkedCashMovement({
      fund_asset_id: 'cash-1',
      fund_id: 'fund-1',
      source_divestment_txn_id: 'sale-1',
      txn_date: '2026-07-08',
      txn_type: 'internal_transfer',
      value_amount: 320000,
    } as never);

    expect(result).toEqual(updated);
    expect(db.update).toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot see another workspace\'s transaction', async () => {
      const dbA = makeDb();
      const dbB = makeDb();
      const repoA = new FundAssetTransactionRepository(dbA as never, 'workspace-a');
      const repoB = new FundAssetTransactionRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 't1', fund_asset_id: 'a1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findById('t1')).toBeDefined();
      expect(await repoB.findById('t1')).toBeUndefined();
    });
  });
});
