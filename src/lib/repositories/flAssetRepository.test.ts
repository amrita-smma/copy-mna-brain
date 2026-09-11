import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlAssetRepository } from './flAssetRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
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
    from: vi.fn().mockReturnThis(),
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

describe('FlAssetRepository', () => {
  let mockDb: MockDb;
  let repo: FlAssetRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlAssetRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates an asset record and returns it', async () => {
      const asset = { id: 'asset-1', workspace_id: 'ws-1', name: 'Acme Corp', asset_kind: 'equity' };
      mockDb.returning.mockResolvedValueOnce([asset]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        name: 'Acme Corp',
        asset_kind: 'equity',
      } as never);

      expect(result).toEqual(asset);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const asset = { id: 'asset-2', workspace_id: 'ws-1', name: 'Beta Loan', asset_kind: 'loan' };
      executorMock.returning.mockResolvedValueOnce([asset]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', name: 'Beta Loan', asset_kind: 'loan' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(asset);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns asset by workspaceId and id when found', async () => {
      const asset = { id: 'asset-1', workspace_id: 'ws-1', name: 'Acme Corp' };
      mockDb.limit.mockResolvedValueOnce([asset]);

      const result = await repo.findById('ws-1', 'asset-1');
      expect(result).toEqual(asset);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const asset = { id: 'asset-1', workspace_id: 'ws-1', name: 'Acme Corp' };
      executorMock.limit.mockResolvedValueOnce([asset]);

      const result = await repo.findById('ws-1', 'asset-1', executorMock as unknown as DbClient);
      expect(result).toEqual(asset);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByIds', () => {
    it('returns empty array without hitting db when ids is empty', async () => {
      const result = await repo.findByIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns assets matching ids list scoped to workspace', async () => {
      const assets = [{ id: 'asset-1', name: 'Acme Corp' }, { id: 'asset-2', name: 'Beta Loan' }];
      mockDb.orderBy.mockResolvedValueOnce(assets);

      const result = await repo.findByIds('ws-1', ['asset-1', 'asset-2']);
      expect(result).toEqual(assets);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all assets in workspace ordered by name and id', async () => {
      const assets = [{ id: 'asset-1', name: 'Acme Corp' }, { id: 'asset-2', name: 'Beta Loan' }];
      mockDb.orderBy.mockResolvedValueOnce(assets);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(assets);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('updates asset scoped by workspace and returns updated row', async () => {
      const updated = { id: 'asset-1', workspace_id: 'ws-1', name: 'Acme Corp Updated' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'asset-1', { name: 'Acme Corp Updated' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes asset by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'asset-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findSystemCashAsset', () => {
    it('queries system cash asset by workspace and normalized currency', async () => {
      const cashAsset = {
        id: 'asset-cash-usd',
        workspace_id: 'ws-1',
        name: 'Cash (USD)',
        asset_kind: 'cash',
        instrument_terms: { system_cash: true, currency: 'USD' },
      };
      mockDb.limit.mockResolvedValueOnce([cashAsset]);

      const result = await repo.findSystemCashAsset('ws-1', ' usd ');
      expect(result).toEqual(cashAsset);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
