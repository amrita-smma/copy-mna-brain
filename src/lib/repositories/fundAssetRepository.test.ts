import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundAssetRepository } from './fundAssetRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
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

describe('FundAssetRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: FundAssetRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FundAssetRepository(db as never, 'workspace-1');
  });

  it('findByFundId returns every asset held by the fund', async () => {
    const asset = { id: 'a1', workspace_id: 'workspace-1', asset_name: 'Acme' };
    db.orderBy.mockResolvedValueOnce([{ asset }]);
    const result = await repo.findByFundId('f1');
    expect(result).toEqual([asset]);
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(db.innerJoin).toHaveBeenCalledTimes(1);
  });

  it('findById returns undefined when no asset matches', async () => {
    db.limit.mockResolvedValueOnce([]);
    const result = await repo.findById('missing');
    expect(result).toBeUndefined();
  });

  it('insert writes the row as-is, including its asset_type', async () => {
    const row = { id: 'a1', workspace_id: 'workspace-1', asset_type: 'direct_investment' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.insert({
      workspace_id: 'workspace-1',
      asset_type: 'direct_investment',
    } as never);
    expect(result).toEqual(row);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ asset_type: 'direct_investment' }),
    );
  });

  it('update sets the given fields and returns the updated row', async () => {
    const row = { id: 'a1', status: 'exited' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.update('a1', { status: 'exited' });
    expect(result).toEqual(row);
  });

  it('markAiOpinionFailedIfProcessing issues a conditional update scoped to processing rows', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.markAiOpinionFailedIfProcessing('a1');
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith({ ai_opinion_status: 'failed' });
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it('completeAiOpinionIfProcessing issues a conditional update scoped to processing rows', async () => {
    const row = { id: 'a1', ai_opinion_status: 'completed' };
    db.returning.mockResolvedValueOnce([row]);
    const result = await repo.completeAiOpinionIfProcessing('a1', {
      ai_opinion_verdict: 'buy',
      ai_opinion_status: 'completed',
    });
    expect(result).toEqual(row);
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith({
      ai_opinion_verdict: 'buy',
      ai_opinion_status: 'completed',
    });
  });

  it('delete removes the asset by id', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('a1');
    expect(db.delete).toHaveBeenCalled();
  });

  describe('workspace isolation', () => {
    it('a repository bound to a different workspace cannot see another workspace\'s asset', async () => {
      const dbA = makeDb();
      const dbB = makeDb();
      const repoA = new FundAssetRepository(dbA as never, 'workspace-a');
      const repoB = new FundAssetRepository(dbB as never, 'workspace-b');

      dbA.limit.mockResolvedValueOnce([{ id: 'a1', fund_id: 'f1' }]);
      dbB.limit.mockResolvedValueOnce([]);

      expect(await repoA.findById('a1')).toBeDefined();
      expect(await repoB.findById('a1')).toBeUndefined();
    });
  });
});
