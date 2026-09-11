import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlValuationRepository } from './flValuationRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  selectDistinctOn: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const mock: MockDb = {
    select: vi.fn().mockReturnThis(),
    selectDistinctOn: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
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
  return mock;
}

describe('FlValuationRepository', () => {
  let mockDb: MockDb;
  let repo: FlValuationRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlValuationRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates a valuation record and returns it', async () => {
      const val = {
        id: 'val-1',
        asset_id: 'asset-1',
        as_of_date: '2026-03-31',
        market_value: '5000000.00000000',
        currency: 'USD',
      };
      mockDb.returning.mockResolvedValueOnce([val]);

      const result = await repo.create({
        asset_id: 'asset-1',
        as_of_date: '2026-03-31',
        market_value: '5000000.00000000',
      } as never);

      expect(result).toEqual(val);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const val = { id: 'val-2', fund_id: 'fund-1', as_of_date: '2026-03-31' };
      executorMock.returning.mockResolvedValueOnce([val]);

      const result = await repo.insert(
        { fund_id: 'fund-1', as_of_date: '2026-03-31' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(val);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns valuation by id and workspace when found via left joins', async () => {
      const val = { id: 'val-1', market_value: '1000' };
      mockDb.limit.mockResolvedValueOnce([{ valuation: val }]);

      const result = await repo.findById('ws-1', 'val-1');
      expect(result).toEqual(val);
      expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const val = { id: 'val-1', market_value: '1000' };
      executorMock.limit.mockResolvedValueOnce([{ valuation: val }]);

      const result = await repo.findById('ws-1', 'val-1', executorMock as unknown as DbClient);
      expect(result).toEqual(val);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(executorMock.leftJoin).toHaveBeenCalledTimes(3);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByIds', () => {
    it('returns empty array without hitting db when ids is empty', async () => {
      const result = await repo.findByIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns valuations matching ids scoped across XOR target joins', async () => {
      const vals = [{ id: 'val-1' }, { id: 'val-2' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findByIds('ws-1', ['val-1', 'val-2']);
      expect(result).toEqual(vals);
      expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findLatestByAssetIds', () => {
    it('returns empty array without hitting db when assetIds is empty', async () => {
      const result = await repo.findLatestByAssetIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.selectDistinctOn).not.toHaveBeenCalled();
    });

    it('returns latest valuations for assets using selectDistinctOn and asset join', async () => {
      const vals = [{ id: 'val-1', asset_id: 'a-1', as_of_date: '2026-03-31' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findLatestByAssetIds('ws-1', ['a-1'], '2026-03-31');
      expect(result).toEqual(vals);
      expect(mockDb.selectDistinctOn).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const vals = [{ id: 'val-1', asset_id: 'a-1' }];
      executorMock.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findLatestByAssetIds('ws-1', ['a-1'], null, executorMock as unknown as DbClient);
      expect(result).toEqual(vals);
      expect(executorMock.selectDistinctOn).toHaveBeenCalledTimes(1);
      expect(executorMock.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.selectDistinctOn).not.toHaveBeenCalled();
    });
  });

  describe('findLatestByFundIds', () => {
    it('returns empty array without hitting db when fundIds is empty', async () => {
      const result = await repo.findLatestByFundIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.selectDistinctOn).not.toHaveBeenCalled();
    });

    it('returns latest valuations for funds using selectDistinctOn and fund join', async () => {
      const vals = [{ id: 'val-1', fund_id: 'f-1', as_of_date: '2026-03-31' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findLatestByFundIds('ws-1', ['f-1'], '2026-03-31');
      expect(result).toEqual(vals);
      expect(mockDb.selectDistinctOn).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });
  });

  describe('findLatestByPositionIds', () => {
    it('returns empty array without hitting db when positionIds is empty', async () => {
      const result = await repo.findLatestByPositionIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.selectDistinctOn).not.toHaveBeenCalled();
    });

    it('returns latest valuations for positions using selectDistinctOn and position join', async () => {
      const vals = [{ id: 'val-1', position_id: 'pos-1', as_of_date: '2026-03-31' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findLatestByPositionIds('ws-1', ['pos-1'], '2026-03-31');
      expect(result).toEqual(vals);
      expect(mockDb.selectDistinctOn).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });
  });

  describe('findSeriesByTarget', () => {
    it('returns time series for asset target joining assets table', async () => {
      const vals = [
        { id: 'v1', asset_id: 'a-1', as_of_date: '2026-01-01' },
        { id: 'v2', asset_id: 'a-1', as_of_date: '2026-03-31' },
      ];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findSeriesByTarget('ws-1', { assetId: 'a-1' });
      expect(result).toEqual(vals);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });

    it('returns time series for fund target joining funds table', async () => {
      const vals = [{ id: 'v1', fund_id: 'f-1', as_of_date: '2026-01-01' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findSeriesByTarget('ws-1', { fundId: 'f-1' });
      expect(result).toEqual(vals);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });

    it('returns time series for position target joining positions table', async () => {
      const vals = [{ id: 'v1', position_id: 'pos-1', as_of_date: '2026-01-01' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findSeriesByTarget('ws-1', { positionId: 'pos-1' });
      expect(result).toEqual(vals);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no target id is provided', async () => {
      const result = await repo.findSeriesByTarget('ws-1', {});
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all valuations in workspace joining target tables', async () => {
      const vals = [{ id: 'val-1' }, { id: 'val-2' }];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(vals);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const vals = [{ id: 'val-1' }];
      executorMock.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findByWorkspaceId('ws-1', executorMock as unknown as DbClient);
      expect(result).toEqual(vals);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByPositionIdsAndAsOfDates', () => {
    it('returns empty without querying when position ids or dates are empty', async () => {
      expect(await repo.findByPositionIdsAndAsOfDates('ws-1', [], ['2024-03-31'])).toEqual([]);
      expect(await repo.findByPositionIdsAndAsOfDates('ws-1', ['pos-1'], [])).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('queries by position ids and dates ordered for grouping', async () => {
      const vals = [
        { id: 'v1', position_id: 'pos-1', as_of_date: '2024-03-31', currency: 'USD' },
        { id: 'v2', position_id: 'pos-2', as_of_date: '2024-06-30', currency: 'USD' },
      ];
      mockDb.orderBy.mockResolvedValueOnce(vals.map((v) => ({ valuation: v })));

      const result = await repo.findByPositionIdsAndAsOfDates(
        'ws-1',
        ['pos-1', 'pos-2', 'pos-1'],
        ['2024-03-31', '2024-06-30'],
      );
      expect(result).toEqual(vals);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('update and delete', () => {
    it('updates valuation and returns updated row', async () => {
      const updated = { id: 'val-1', market_value: '2000' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('val-1', { market_value: '2000' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it('deletes valuation by id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('val-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });
  });
});
