import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/repositories';
import {
  EntityNotFoundError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidMasterDataError,
  ManagedFundInvestorConflictError,
  WorkspaceMismatchError,
} from './flErrors';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import { FlMasterDataService, getCashAssetCurrency } from './flMasterDataService';

describe('FlMasterDataService', () => {
  let mockDb: any;
  let mockInvestorRepo: any;
  let mockFundRepo: any;
  let mockAssetRepo: any;
  let mockFundingSourceRepo: any;
  let service: FlMasterDataService;

  const workspaceId = 'ws-123';
  const sentinelExecutor = { __sentinel: 'tx-client' } as unknown as DbClient;

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (callback: any) => callback(mockDb)),
    };
    mockInvestorRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(undefined),
      findByCanonicalName: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'inv-1', ...data })),
      insertOnConflictDoNothing: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'inv-1', ...data })),
      update: vi.fn().mockImplementation((_ws: any, id: any, data: any) => Promise.resolve({ id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    mockFundRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(undefined),
      findByCanonicalName: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'fund-1', ...data })),
      insertOnConflictDoNothing: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'fund-1', ...data })),
      update: vi.fn().mockImplementation((_ws: any, id: any, data: any) => Promise.resolve({ id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    mockAssetRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(undefined),
      findByCanonicalName: vi.fn().mockResolvedValue(undefined),
      findSystemCashAsset: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'asset-1', ...data })),
      insertOnConflictDoNothing: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'asset-1', ...data })),
      update: vi.fn().mockImplementation((_ws: any, id: any, data: any) => Promise.resolve({ id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    mockFundingSourceRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(undefined),
      findByCanonicalName: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'src-1', ...data })),
      insertOnConflictDoNothing: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'src-1', ...data })),
      update: vi.fn().mockImplementation((_ws: any, id: any, data: any) => Promise.resolve({ id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    service = new FlMasterDataService(
      mockDb,
      mockInvestorRepo,
      mockFundRepo,
      mockAssetRepo,
      mockFundingSourceRepo,
    );
  });

  describe('Investors', () => {
    it('creates an investor without parent', async () => {
      const result = await service.createInvestor(workspaceId, {
        name: 'LP Alpha',
        investor_type: 'institution',
      });
      expect(result.name).toBe('LP Alpha');
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockInvestorRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'LP Alpha', workspace_id: workspaceId }),
        mockDb,
      );
    });

    it('validates parent_investor_id in the same workspace', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'parent-1', workspace_id: workspaceId });

      const result = await service.createInvestor(workspaceId, {
        name: 'Subsidiary LP',
        investor_type: 'institution',
        parent_investor_id: 'parent-1',
      });
      expect(result.parent_investor_id).toBe('parent-1');
      expect(mockInvestorRepo.findById).toHaveBeenCalledWith(workspaceId, 'parent-1', mockDb);
    });

    it('rejects parent_investor_id if not found in workspace', async () => {
      mockInvestorRepo.findById.mockResolvedValue(undefined);

      await expect(
        service.createInvestor(workspaceId, {
          name: 'Subsidiary LP',
          investor_type: 'institution',
          parent_investor_id: 'parent-missing',
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('threads sentinel executor to all repo calls without nested transaction', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'parent-1', workspace_id: workspaceId });

      await service.createInvestor(
        workspaceId,
        {
          name: 'LP Beta',
          investor_type: 'individual',
          parent_investor_id: 'parent-1',
        },
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockInvestorRepo.findById).toHaveBeenCalledWith(workspaceId, 'parent-1', sentinelExecutor);
      expect(mockInvestorRepo.create).toHaveBeenCalledWith(expect.anything(), sentinelExecutor);
    });

    it('rejects empty investor name with InvalidMasterDataError', async () => {
      await expect(
        service.createInvestor(workspaceId, {
          name: '   ',
          investor_type: 'individual',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid investor_type with InvalidMasterDataError', async () => {
      await expect(
        service.createInvestor(workspaceId, {
          name: 'LP Beta',
          investor_type: 'invalid_type' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });
  });

  describe('Funds', () => {
    it('creates a fund with valid base currency, status, and string rates', async () => {
      const fund = await service.createFund(workspaceId, {
        name: 'Fund I',
        ownership_basis: 'commitment',
        base_currency: 'USD',
        mgmt_fee_rate: '0.020000',
        carry_rate: '0.200000',
      });
      expect(fund.name).toBe('Fund I');
      expect(fund.base_currency).toBe('USD');
      expect(fund.mgmt_fee_rate).toBe('0.020000');
    });

    it('rejects empty fund name with InvalidMasterDataError', async () => {
      await expect(
        service.createFund(workspaceId, {
          name: '',
          ownership_basis: 'commitment',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid ownership_basis with InvalidMasterDataError', async () => {
      await expect(
        service.createFund(workspaceId, {
          name: 'Fund I',
          ownership_basis: 'invalid_basis' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid fund status with InvalidMasterDataError', async () => {
      await expect(
        service.createFund(workspaceId, {
          name: 'Fund I',
          ownership_basis: 'commitment',
          status: 'invalid_status' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects non-string fee rates at runtime', async () => {
      await expect(
        service.createFund(workspaceId, {
          name: 'Fund I',
          ownership_basis: 'commitment',
          mgmt_fee_rate: 0.02 as any,
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects invalid currency in fund creation', async () => {
      await expect(
        service.createFund(workspaceId, {
          name: 'Fund I',
          ownership_basis: 'commitment',
          base_currency: 'INVALID',
        }),
      ).rejects.toThrow(InvalidCurrencyError);
    });

    it('threads sentinel executor to fund create', async () => {
      await service.createFund(
        workspaceId,
        {
          name: 'Fund II',
          ownership_basis: 'units',
        },
        sentinelExecutor,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockFundRepo.create).toHaveBeenCalledWith(expect.anything(), sentinelExecutor);
    });
  });

  describe('Assets', () => {
    it('creates an asset', async () => {
      const asset = await service.createAsset(workspaceId, {
        name: 'TechCorp Equity',
        asset_kind: 'equity',
      });
      expect(asset.name).toBe('TechCorp Equity');
      expect(asset.asset_kind).toBe('equity');
    });

    it('rejects empty asset name with InvalidMasterDataError', async () => {
      await expect(
        service.createAsset(workspaceId, {
          name: '',
          asset_kind: 'equity',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid asset_kind with InvalidMasterDataError', async () => {
      await expect(
        service.createAsset(workspaceId, {
          name: 'TechCorp Equity',
          asset_kind: 'non_existent_kind' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });
  });

  describe('Funding Sources', () => {
    it('creates a funding source and validates currency', async () => {
      const src = await service.createFundingSource(workspaceId, {
        name: 'Treasury Pool',
        currency: 'USD',
      });
      expect(src.name).toBe('Treasury Pool');
    });

    it('rejects empty funding source name with InvalidMasterDataError', async () => {
      await expect(
        service.createFundingSource(workspaceId, {
          name: '',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid currency on funding source', async () => {
      await expect(
        service.createFundingSource(workspaceId, {
          name: 'Treasury Pool',
          currency: 'XYZ123',
        }),
      ).rejects.toThrow(InvalidCurrencyError);
    });

    it('validates owner_investor_id in workspace', async () => {
      mockInvestorRepo.findById.mockResolvedValue(undefined);
      await expect(
        service.createFundingSource(workspaceId, {
          name: 'Pool A',
          owner_investor_id: 'inv-cross-workspace',
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('threads sentinel executor for owner check and create', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      await service.createFundingSource(
        workspaceId,
        {
          name: 'Pool B',
          owner_investor_id: 'inv-1',
        },
        sentinelExecutor,
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockInvestorRepo.findById).toHaveBeenCalledWith(workspaceId, 'inv-1', sentinelExecutor);
      expect(mockFundingSourceRepo.create).toHaveBeenCalledWith(expect.anything(), sentinelExecutor);
    });
  });

  describe('Update and Delete Master Data', () => {
    it('updates investor and validates parent_investor_id', async () => {
      mockInvestorRepo.findById
        .mockResolvedValueOnce({ id: 'inv-1', workspace_id: workspaceId })
        .mockResolvedValueOnce({ id: 'parent-1', workspace_id: workspaceId });

      const updated = await service.updateInvestor(workspaceId, 'inv-1', {
        name: 'Updated LP',
        parent_investor_id: 'parent-1',
      });
      expect(updated.name).toBe('Updated LP');
      expect(mockInvestorRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'inv-1',
        expect.objectContaining({ name: 'Updated LP', parent_investor_id: 'parent-1' }),
        mockDb,
      );
    });

    it('rejects self-parenting on investor update', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      await expect(
        service.updateInvestor(workspaceId, 'inv-1', {
          parent_investor_id: 'inv-1',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects cyclical parent hierarchy on investor update (A -> B -> A)', async () => {
      mockInvestorRepo.findById.mockImplementation(async (_ws, id) => {
        if (id === 'inv-A') {
          return { id: 'inv-A', workspace_id: workspaceId, parent_investor_id: null } as any;
        }
        if (id === 'inv-B') {
          return { id: 'inv-B', workspace_id: workspaceId, parent_investor_id: 'inv-A' } as any;
        }
        return undefined;
      });

      await expect(
        service.updateInvestor(workspaceId, 'inv-A', {
          parent_investor_id: 'inv-B',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects longer cycle on investor update (A -> B -> C -> A)', async () => {
      mockInvestorRepo.findById.mockImplementation(async (_ws, id) => {
        if (id === 'inv-A') {
          return { id: 'inv-A', workspace_id: workspaceId, parent_investor_id: null } as any;
        }
        if (id === 'inv-B') {
          return { id: 'inv-B', workspace_id: workspaceId, parent_investor_id: 'inv-C' } as any;
        }
        if (id === 'inv-C') {
          return { id: 'inv-C', workspace_id: workspaceId, parent_investor_id: 'inv-A' } as any;
        }
        return undefined;
      });

      await expect(
        service.updateInvestor(workspaceId, 'inv-A', {
          parent_investor_id: 'inv-B',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('cycle walk terminates without hanging on corrupt/self-referential ancestor data', async () => {
      mockInvestorRepo.findById.mockImplementation(async (_ws, id) => {
        if (id === 'inv-A') {
          return { id: 'inv-A', workspace_id: workspaceId, parent_investor_id: null } as any;
        }
        if (id === 'inv-B') {
          return { id: 'inv-B', workspace_id: workspaceId, parent_investor_id: 'inv-C' } as any;
        }
        if (id === 'inv-C') {
          return { id: 'inv-C', workspace_id: workspaceId, parent_investor_id: 'inv-C' } as any;
        }
        return undefined;
      });
      mockInvestorRepo.update.mockResolvedValue({
        id: 'inv-A',
        workspace_id: workspaceId,
        parent_investor_id: 'inv-B',
      } as any);

      const result = await service.updateInvestor(workspaceId, 'inv-A', {
        parent_investor_id: 'inv-B',
      });
      expect(result.parent_investor_id).toBe('inv-B');
    });

    it('cycle walk terminates without hanging when exceeding 50 hops', async () => {
      mockInvestorRepo.findById.mockImplementation(async (_ws, id) => {
        if (id === 'inv-A') {
          return { id: 'inv-A', workspace_id: workspaceId, parent_investor_id: null } as any;
        }
        const match = id.match(/^inv-(\d+)$/);
        const num = match ? parseInt(match[1], 10) : 0;
        return {
          id,
          workspace_id: workspaceId,
          parent_investor_id: `inv-${num + 1}`,
        } as any;
      });
      mockInvestorRepo.update.mockResolvedValue({
        id: 'inv-A',
        workspace_id: workspaceId,
        parent_investor_id: 'inv-1',
      } as any);

      const result = await service.updateInvestor(workspaceId, 'inv-A', {
        parent_investor_id: 'inv-1',
      });
      expect(result.parent_investor_id).toBe('inv-1');
    });

    it('rejects empty name on investor update', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      await expect(
        service.updateInvestor(workspaceId, 'inv-1', {
          name: '   ',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid investor_type on investor update', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      await expect(
        service.updateInvestor(workspaceId, 'inv-1', {
          investor_type: 'invalid_type' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects empty name on fund update', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'f-1', workspace_id: workspaceId });
      await expect(
        service.updateFund(workspaceId, 'f-1', {
          name: '',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid ownership_basis on fund update', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'f-1', workspace_id: workspaceId });
      await expect(
        service.updateFund(workspaceId, 'f-1', {
          ownership_basis: 'invalid_basis' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid status on fund update', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'f-1', workspace_id: workspaceId });
      await expect(
        service.updateFund(workspaceId, 'f-1', {
          status: 'invalid_status' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects empty name on asset update', async () => {
      mockAssetRepo.findById.mockResolvedValue({ id: 'a-1', workspace_id: workspaceId });
      await expect(
        service.updateAsset(workspaceId, 'a-1', {
          name: '',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects invalid asset_kind on asset update', async () => {
      mockAssetRepo.findById.mockResolvedValue({ id: 'a-1', workspace_id: workspaceId });
      await expect(
        service.updateAsset(workspaceId, 'a-1', {
          asset_kind: 'invalid_kind' as any,
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('rejects empty name on funding source update', async () => {
      mockFundingSourceRepo.findById.mockResolvedValue({ id: 'src-1', workspace_id: workspaceId });
      await expect(
        service.updateFundingSource(workspaceId, 'src-1', {
          name: '',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('updates fund with strict string rates and rejects non-strings', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'f-1', workspace_id: workspaceId });

      const updated = await service.updateFund(workspaceId, 'f-1', {
        mgmt_fee_rate: '0.015000',
      });
      expect(updated.mgmt_fee_rate).toBe('0.015000');

      await expect(
        service.updateFund(workspaceId, 'f-1', {
          mgmt_fee_rate: 0.015 as any,
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('updates asset and deletes asset with workspace validation', async () => {
      mockAssetRepo.findById.mockResolvedValue({ id: 'a-1', workspace_id: workspaceId });

      const updated = await service.updateAsset(workspaceId, 'a-1', {
        name: 'New Asset Name',
      });
      expect(updated.name).toBe('New Asset Name');

      await service.deleteAsset(workspaceId, 'a-1');
      expect(mockAssetRepo.delete).toHaveBeenCalledWith(workspaceId, 'a-1', mockDb);
    });

    it('updates and deletes funding sources', async () => {
      mockFundingSourceRepo.findById.mockResolvedValue({ id: 'src-1', workspace_id: workspaceId });
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });

      const updated = await service.updateFundingSource(workspaceId, 'src-1', {
        name: 'New Source',
        owner_investor_id: 'inv-1',
      });
      expect(updated.name).toBe('New Source');

      await service.deleteFundingSource(workspaceId, 'src-1');
      expect(mockFundingSourceRepo.delete).toHaveBeenCalledWith(workspaceId, 'src-1', mockDb);
    });

    it('persists and updates english_name on investors and funds', async () => {
      // Create investor with english_name
      const createdInv = await service.createInvestor(workspaceId, {
        name: '南京投资',
        english_name: 'Nanjing Investment',
        investor_type: 'institution',
      });
      expect(createdInv.english_name).toBe('Nanjing Investment');
      expect(mockInvestorRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '南京投资',
          english_name: 'Nanjing Investment',
        }),
        mockDb,
      );

      // Update investor english_name
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      const updatedInv = await service.updateInvestor(workspaceId, 'inv-1', {
        english_name: 'Nanjing Capital',
      });
      expect(updatedInv.english_name).toBe('Nanjing Capital');
      expect(mockInvestorRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'inv-1',
        expect.objectContaining({ english_name: 'Nanjing Capital' }),
        mockDb,
      );

      // Create fund with english_name
      const createdFund = await service.createFund(workspaceId, {
        name: '南京一期基金',
        english_name: 'Nanjing Fund I',
        ownership_basis: 'commitment',
        base_currency: 'CNY',
      });
      expect(createdFund.english_name).toBe('Nanjing Fund I');
      expect(mockFundRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '南京一期基金',
          english_name: 'Nanjing Fund I',
        }),
        mockDb,
      );

      // Update fund english_name
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      const updatedFund = await service.updateFund(workspaceId, 'fund-1', {
        english_name: 'Nanjing Growth Fund I',
      });
      expect(updatedFund.english_name).toBe('Nanjing Growth Fund I');
      expect(mockFundRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'fund-1',
        expect.objectContaining({ english_name: 'Nanjing Growth Fund I' }),
        mockDb,
      );
    });

    it('rejects duplicate names on update for investors, funds, assets, and funding sources', async () => {
      // Investor update duplicate
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', name: 'Original LP', workspace_id: workspaceId });
      mockInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'inv-1', name: 'Original LP', workspace_id: workspaceId },
        { id: 'inv-2', name: 'Existing LP', workspace_id: workspaceId },
      ]);
      await expect(
        service.updateInvestor(workspaceId, 'inv-1', { name: '  existing   lp  ' }),
      ).rejects.toThrow(InvalidMasterDataError);

      // Fund update duplicate
      mockFundRepo.findById.mockResolvedValue({ id: 'f-1', name: 'Original Fund', workspace_id: workspaceId });
      mockFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'f-1', name: 'Original Fund', workspace_id: workspaceId },
        { id: 'f-2', name: 'Startech Fund I', workspace_id: workspaceId },
      ]);
      await expect(
        service.updateFund(workspaceId, 'f-1', { name: 'startech fund i' }),
      ).rejects.toThrow(InvalidMasterDataError);

      // Asset update duplicate
      mockAssetRepo.findById.mockResolvedValue({ id: 'a-1', name: 'Original Asset', workspace_id: workspaceId });
      mockAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'a-1', name: 'Original Asset', workspace_id: workspaceId },
        { id: 'a-2', name: '赛德特生物制药有限公司', workspace_id: workspaceId },
      ]);
      await expect(
        service.updateAsset(workspaceId, 'a-1', { name: '赛德特生物制药有限公司 Saidet Biotech' }),
      ).rejects.toThrow(InvalidMasterDataError);

      // Funding source update duplicate
      mockFundingSourceRepo.findById.mockResolvedValue({ id: 'src-1', name: 'Original Source', workspace_id: workspaceId });
      mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'src-1', name: 'Original Source', workspace_id: workspaceId },
        { id: 'src-2', name: 'Treasury Pool', workspace_id: workspaceId },
      ]);
      await expect(
        service.updateFundingSource(workspaceId, 'src-1', { name: '  TREASURY POOL ' }),
      ).rejects.toThrow(InvalidMasterDataError);
    });
  });

  describe('Deduplication & getOrCreate methods', () => {
    it('createInvestor rejects duplicate with InvalidMasterDataError', async () => {
      mockInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'inv-1', name: '南京投资主体', workspace_id: workspaceId },
      ]);

      await expect(
        service.createInvestor(workspaceId, {
          name: '  南京 投资主体  ',
          investor_type: 'institution',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('getOrCreateInvestor returns existing investor and backfills english_name if empty', async () => {
      mockInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'inv-1', name: '南京投资主体', english_name: null, workspace_id: workspaceId },
      ]);
      mockInvestorRepo.update.mockResolvedValue({
        id: 'inv-1',
        name: '南京投资主体',
        english_name: 'Nanjing Investment',
        workspace_id: workspaceId,
      });

      const res = await service.getOrCreateInvestor(workspaceId, {
        name: '南京投资主体 Nanjing Investment',
        english_name: 'Nanjing Investment',
        investor_type: 'institution',
      });

      expect(res.id).toBe('inv-1');
      expect(mockInvestorRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'inv-1',
        { english_name: 'Nanjing Investment' },
        mockDb,
      );
      expect(mockInvestorRepo.create).not.toHaveBeenCalled();
    });

    it('createFund rejects duplicate fund with InvalidMasterDataError', async () => {
      mockFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'fund-1', name: 'Startech Growth Fund 1', workspace_id: workspaceId },
      ]);

      await expect(
        service.createFund(workspaceId, {
          name: 'STARTECH  GROWTH   FUND 1',
          ownership_basis: 'commitment',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('getOrCreateFund reuses existing fund and updates registration_no/english_name', async () => {
      mockFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'fund-1', name: '南京瑞满基金', registration_no: null, english_name: null, workspace_id: workspaceId },
      ]);
      mockFundRepo.update.mockResolvedValue({
        id: 'fund-1',
        name: '南京瑞满基金',
        registration_no: 'P123456',
        english_name: 'Ruiman Fund',
        workspace_id: workspaceId,
      });

      const res = await service.getOrCreateFund(workspaceId, {
        name: '南京瑞满基金',
        registration_no: 'P123456',
        english_name: 'Ruiman Fund',
        ownership_basis: 'commitment',
      });

      expect(res.id).toBe('fund-1');
      expect(mockFundRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'fund-1',
        { registration_no: 'P123456', english_name: 'Ruiman Fund' },
        mockDb,
      );
      expect(mockFundRepo.create).not.toHaveBeenCalled();
    });

    it('createAsset rejects duplicate asset with InvalidMasterDataError', async () => {
      mockAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'asset-1', name: '赛德特生物制药有限公司', workspace_id: workspaceId },
      ]);

      await expect(
        service.createAsset(workspaceId, {
          name: '  赛德特 生物制药 有限公司  Saidet Biotech',
          asset_kind: 'equity',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('getOrCreateAsset returns existing asset and backfills english_name', async () => {
      mockAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'asset-1', name: '赛德特生物制药有限公司', english_name: null, workspace_id: workspaceId },
      ]);
      mockAssetRepo.update.mockResolvedValue({
        id: 'asset-1',
        name: '赛德特生物制药有限公司',
        english_name: 'Saidet Biotech Co., Ltd.',
        workspace_id: workspaceId,
      });

      const res = await service.getOrCreateAsset(workspaceId, {
        name: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
        english_name: 'Saidet Biotech Co., Ltd.',
        asset_kind: 'equity',
      });

      expect(res.id).toBe('asset-1');
      expect(mockAssetRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'asset-1',
        { english_name: 'Saidet Biotech Co., Ltd.' },
        mockDb,
      );
      expect(mockAssetRepo.create).not.toHaveBeenCalled();
    });

    it('createFundingSource rejects duplicate funding source with InvalidMasterDataError', async () => {
      mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'src-1', name: 'Treasury Pool', workspace_id: workspaceId },
      ]);

      await expect(
        service.createFundingSource(workspaceId, {
          name: '  TREASURY   POOL  ',
        }),
      ).rejects.toThrow(InvalidMasterDataError);
    });

    it('getOrCreateFundingSource returns existing funding source', async () => {
      mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'src-1', name: 'Treasury Pool', workspace_id: workspaceId },
      ]);

      const res = await service.getOrCreateFundingSource(workspaceId, {
        name: 'treasury pool',
      });

      expect(res.id).toBe('src-1');
      expect(mockFundingSourceRepo.create).not.toHaveBeenCalled();
    });

    describe('transaction-safe concurrent recovery in getOrCreate*', () => {
      it('getOrCreateInvestor recovers on concurrent insert race via insertOnConflictDoNothing + findByCanonicalName', async () => {
        // Pre-query finds nothing
        mockInvestorRepo.findByWorkspaceId.mockResolvedValueOnce([]);
        // Concurrent transaction won the race, so insertOnConflictDoNothing returns undefined (DO NOTHING)
        mockInvestorRepo.insertOnConflictDoNothing.mockResolvedValueOnce(undefined);
        // Canonical lookup finds winner
        mockInvestorRepo.findByCanonicalName.mockResolvedValueOnce({
          id: 'inv-winner',
          name: '南京国资投资主体',
          english_name: null,
          workspace_id: workspaceId,
        });
        mockInvestorRepo.update.mockResolvedValueOnce({
          id: 'inv-winner',
          name: '南京国资投资主体',
          english_name: 'Nanjing State-owned Investment',
          workspace_id: workspaceId,
        });

        const res = await service.getOrCreateInvestor(workspaceId, {
          name: '南京国资投资主体',
          english_name: 'Nanjing State-owned Investment',
          investor_type: 'institution',
        });

        expect(res.id).toBe('inv-winner');
        expect(mockInvestorRepo.insertOnConflictDoNothing).toHaveBeenCalled();
        expect(mockInvestorRepo.findByCanonicalName).toHaveBeenCalledWith(
          workspaceId,
          '南京国资投资主体',
          mockDb,
        );
        expect(mockInvestorRepo.update).toHaveBeenCalledWith(
          workspaceId,
          'inv-winner',
          { english_name: 'Nanjing State-owned Investment' },
          mockDb,
        );
      });

      it('getOrCreateFund recovers on concurrent insert race via insertOnConflictDoNothing + findByCanonicalName', async () => {
        mockFundRepo.findByWorkspaceId.mockResolvedValueOnce([]);
        mockFundRepo.insertOnConflictDoNothing.mockResolvedValueOnce(undefined);
        mockFundRepo.findByCanonicalName.mockResolvedValueOnce({
          id: 'fund-winner',
          name: '南京瑞满基金',
          registration_no: null,
          english_name: null,
          workspace_id: workspaceId,
        });
        mockFundRepo.update.mockResolvedValueOnce({
          id: 'fund-winner',
          name: '南京瑞满基金',
          registration_no: 'P999999',
          english_name: 'Ruiman Winner Fund',
          workspace_id: workspaceId,
        });

        const res = await service.getOrCreateFund(workspaceId, {
          name: '南京 瑞满 基金',
          registration_no: 'P999999',
          english_name: 'Ruiman Winner Fund',
          ownership_basis: 'commitment',
        });

        expect(res.id).toBe('fund-winner');
        expect(mockFundRepo.insertOnConflictDoNothing).toHaveBeenCalled();
        expect(mockFundRepo.findByCanonicalName).toHaveBeenCalledWith(
          workspaceId,
          '南京瑞满基金',
          mockDb,
        );
        expect(mockFundRepo.update).toHaveBeenCalledWith(
          workspaceId,
          'fund-winner',
          { registration_no: 'P999999', english_name: 'Ruiman Winner Fund' },
          mockDb,
        );
      });

      it('getOrCreateAsset recovers on concurrent insert race via insertOnConflictDoNothing + findByCanonicalName', async () => {
        mockAssetRepo.findByWorkspaceId.mockResolvedValueOnce([]);
        mockAssetRepo.insertOnConflictDoNothing.mockResolvedValueOnce(undefined);
        mockAssetRepo.findByCanonicalName.mockResolvedValueOnce({
          id: 'asset-winner',
          name: '赛德特生物制药有限公司',
          english_name: null,
          workspace_id: workspaceId,
        });
        mockAssetRepo.update.mockResolvedValueOnce({
          id: 'asset-winner',
          name: '赛德特生物制药有限公司',
          english_name: 'Saidet Biotech Co., Ltd.',
          workspace_id: workspaceId,
        });

        const res = await service.getOrCreateAsset(workspaceId, {
          name: '  赛德特 生物制药 有限公司  Saidet Biotech',
          english_name: 'Saidet Biotech Co., Ltd.',
          asset_kind: 'equity',
        });

        expect(res.id).toBe('asset-winner');
        expect(mockAssetRepo.insertOnConflictDoNothing).toHaveBeenCalled();
        expect(mockAssetRepo.findByCanonicalName).toHaveBeenCalledWith(
          workspaceId,
          '赛德特生物制药有限公司',
          mockDb,
        );
        expect(mockAssetRepo.update).toHaveBeenCalledWith(
          workspaceId,
          'asset-winner',
          { english_name: 'Saidet Biotech Co., Ltd.' },
          mockDb,
        );
      });

      it('getOrCreateFundingSource recovers on concurrent insert race via insertOnConflictDoNothing + findByCanonicalName', async () => {
        mockFundingSourceRepo.findByWorkspaceId.mockResolvedValueOnce([]);
        mockFundingSourceRepo.insertOnConflictDoNothing.mockResolvedValueOnce(undefined);
        mockFundingSourceRepo.findByCanonicalName.mockResolvedValueOnce({
          id: 'src-winner',
          name: 'Treasury Pool',
          workspace_id: workspaceId,
        });

        const res = await service.getOrCreateFundingSource(workspaceId, {
          name: 'TREASURY POOL',
        });

        expect(res.id).toBe('src-winner');
        expect(mockFundingSourceRepo.insertOnConflictDoNothing).toHaveBeenCalled();
        expect(mockFundingSourceRepo.findByCanonicalName).toHaveBeenCalledWith(
          workspaceId,
          'treasury pool',
          mockDb,
        );
      });
    });

    describe('Cash Assets', () => {
      describe('getCashAssetCurrency', () => {
        it('returns undefined for non-objects or objects without instrument_terms', () => {
          expect(getCashAssetCurrency(null)).toBeUndefined();
          expect(getCashAssetCurrency(undefined)).toBeUndefined();
          expect(getCashAssetCurrency({} as any)).toBeUndefined();
          expect(getCashAssetCurrency({ instrument_terms: null } as any)).toBeUndefined();
          expect(getCashAssetCurrency({ instrument_terms: {} } as any)).toBeUndefined();
        });

        it('returns trimmed uppercase currency when valid', () => {
          expect(
            getCashAssetCurrency({
              instrument_terms: { currency: 'usd', system_cash: true },
            } as any),
          ).toBe('USD');
          expect(
            getCashAssetCurrency({
              instrument_terms: { currency: '  eur  ' },
            } as any),
          ).toBe('EUR');
        });
      });

      describe('getOrCreateCashAsset', () => {
        it('returns existing cash asset if found', async () => {
          const existingCash = {
            id: 'asset-cash-usd',
            workspace_id: workspaceId,
            name: 'Cash (USD)',
            asset_kind: 'cash',
            instrument_terms: { system_cash: true, currency: 'USD' },
          };
          mockAssetRepo.findSystemCashAsset.mockResolvedValueOnce(existingCash);

          const res = await service.getOrCreateCashAsset(workspaceId, 'USD');
          expect(res.id).toBe('asset-cash-usd');
          expect(mockAssetRepo.create).not.toHaveBeenCalled();
        });

        it('creates cash asset if not found', async () => {
          mockAssetRepo.findSystemCashAsset.mockResolvedValueOnce(undefined);
          mockAssetRepo.create.mockImplementationOnce((data: any) =>
            Promise.resolve({ id: 'asset-new-usd', ...data }),
          );

          const res = await service.getOrCreateCashAsset(workspaceId, 'usd');
          expect(res.id).toBe('asset-new-usd');
          expect(mockAssetRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
              workspace_id: workspaceId,
              name: 'Cash (USD)',
              canonical_name: 'cash (usd)',
              asset_kind: 'cash',
              instrument_terms: { system_cash: true, currency: 'USD' },
            }),
            mockDb,
          );
        });

        it('recovers on concurrent insert race when unique constraint is violated', async () => {
          mockAssetRepo.findSystemCashAsset
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({
              id: 'asset-winner-usd',
              name: 'Cash (USD)',
              asset_kind: 'cash',
              instrument_terms: { system_cash: true, currency: 'USD' },
            });

          const uniqueError = new Error(
            'duplicate key value violates unique constraint "fl_assets_system_cash_currency_uniq"',
          );
          (uniqueError as any).code = '23505';
          mockAssetRepo.create.mockRejectedValueOnce(uniqueError);

          const res = await service.getOrCreateCashAsset(workspaceId, 'USD');
          expect(res.id).toBe('asset-winner-usd');
          expect(mockAssetRepo.create).toHaveBeenCalled();
          expect(mockAssetRepo.findSystemCashAsset).toHaveBeenCalledTimes(2);
        });

        it('rethrows unexpected errors from create', async () => {
          mockAssetRepo.findSystemCashAsset.mockResolvedValueOnce(undefined);
          mockAssetRepo.create.mockRejectedValueOnce(new Error('connection terminated'));

          await expect(service.getOrCreateCashAsset(workspaceId, 'USD')).rejects.toThrow(
            'connection terminated',
          );
        });
      });
    });
  });

  describe('managed fund / investor name conflict', () => {
    const fundName = '南京月升星繁创业投资合伙企业（有限合伙）';
    const fundCanonical = normalizeCanonicalName(fundName);
    const managedFund = { id: 'fund-ys', name: fundName, canonical_name: fundCanonical, managed: true };
    const investorRow = { id: 'inv-ys', name: fundName, canonical_name: fundCanonical, english_name: null };

    it('createInvestor rejects a name that is a managed fund and writes nothing', async () => {
      mockFundRepo.findByCanonicalName.mockResolvedValue(managedFund);

      await expect(
        service.createInvestor(workspaceId, { name: fundName, investor_type: 'institution' }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockInvestorRepo.create).not.toHaveBeenCalled();
    });

    it('createInvestor accepts a name that is only an unmanaged fund', async () => {
      mockFundRepo.findByCanonicalName.mockResolvedValue({ ...managedFund, managed: false });

      await service.createInvestor(workspaceId, { name: fundName, investor_type: 'institution' });
      expect(mockInvestorRepo.create).toHaveBeenCalled();
    });

    it('createInvestor accepts the management company of a managed fund (exact canonical match only)', async () => {
      mockFundRepo.findByCanonicalName.mockImplementation(async (_ws: string, canonical: string) =>
        canonical === fundCanonical ? managedFund : undefined,
      );

      await service.createInvestor(workspaceId, {
        name: '南京金光紫金创业投资管理有限公司',
        investor_type: 'institution',
      });
      expect(mockInvestorRepo.create).toHaveBeenCalled();
    });

    it('createInvestor looks the fund up on the caller executor', async () => {
      await service.createInvestor(
        workspaceId,
        { name: 'LP Gamma', investor_type: 'institution' },
        sentinelExecutor,
      );
      expect(mockFundRepo.findByCanonicalName).toHaveBeenCalledWith(
        workspaceId,
        expect.any(String),
        sentinelExecutor,
      );
    });

    it('getOrCreateInvestor rejects creating an investor named after a managed fund', async () => {
      mockFundRepo.findByCanonicalName.mockResolvedValue(managedFund);

      await expect(
        service.getOrCreateInvestor(workspaceId, { name: fundName, investor_type: 'institution' }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockInvestorRepo.insertOnConflictDoNothing).not.toHaveBeenCalled();
    });

    it('getOrCreateInvestor still returns an existing same-named investor without throwing', async () => {
      mockFundRepo.findByCanonicalName.mockResolvedValue(managedFund);
      mockInvestorRepo.findByWorkspaceId.mockResolvedValue([investorRow]);

      const result = await service.getOrCreateInvestor(workspaceId, {
        name: fundName,
        investor_type: 'institution',
      });
      expect(result.id).toBe('inv-ys');
      expect(mockFundRepo.findByCanonicalName).not.toHaveBeenCalled();
    });

    it('updateInvestor rejects renaming an investor to a managed fund name', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', name: 'LP Alpha', canonical_name: normalizeCanonicalName('LP Alpha') });
      mockFundRepo.findByCanonicalName.mockResolvedValue(managedFund);

      await expect(
        service.updateInvestor(workspaceId, 'inv-1', { name: fundName }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockInvestorRepo.update).not.toHaveBeenCalled();
    });

    it('updateInvestor leaves an existing same-named investor editable when its name is unchanged', async () => {
      mockInvestorRepo.findById.mockResolvedValue(investorRow);
      mockFundRepo.findByCanonicalName.mockResolvedValue(managedFund);

      await service.updateInvestor(workspaceId, 'inv-ys', { name: fundName, notes: 'legacy row' });
      expect(mockInvestorRepo.update).toHaveBeenCalled();
    });

    it('createFund rejects a managed fund named after an existing investor', async () => {
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await expect(
        service.createFund(workspaceId, { name: fundName, ownership_basis: 'commitment', managed: true }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockFundRepo.create).not.toHaveBeenCalled();
    });

    it('createFund accepts an unmanaged fund named after an existing investor', async () => {
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await service.createFund(workspaceId, { name: fundName, ownership_basis: 'commitment' });
      expect(mockFundRepo.create).toHaveBeenCalled();
      expect(mockInvestorRepo.findByCanonicalName).not.toHaveBeenCalled();
    });

    it('getOrCreateFund rejects inserting a managed fund named after an existing investor', async () => {
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await expect(
        service.getOrCreateFund(workspaceId, { name: fundName, ownership_basis: 'commitment', managed: true }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockFundRepo.insertOnConflictDoNothing).not.toHaveBeenCalled();
    });

    it('getOrCreateFund still returns an existing managed fund when a same-named investor exists', async () => {
      mockFundRepo.findByWorkspaceId.mockResolvedValue([managedFund]);
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      const result = await service.getOrCreateFund(workspaceId, {
        name: fundName,
        ownership_basis: 'commitment',
        managed: true,
      });
      expect(result.id).toBe('fund-ys');
      expect(mockInvestorRepo.findByCanonicalName).not.toHaveBeenCalled();
    });

    it('updateFund rejects marking a fund managed while a same-named investor exists', async () => {
      mockFundRepo.findById.mockResolvedValue({ ...managedFund, managed: false });
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await expect(
        service.updateFund(workspaceId, 'fund-ys', { managed: true }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockFundRepo.update).not.toHaveBeenCalled();
    });

    it('updateFund rejects renaming a managed fund to an existing investor name', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', name: 'Fund A', canonical_name: normalizeCanonicalName('Fund A'), managed: true });
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await expect(
        service.updateFund(workspaceId, 'fund-1', { name: fundName }),
      ).rejects.toThrow(ManagedFundInvestorConflictError);
      expect(mockFundRepo.update).not.toHaveBeenCalled();
    });

    it('updateFund leaves an already-managed fund editable when its name is unchanged', async () => {
      mockFundRepo.findById.mockResolvedValue(managedFund);
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await service.updateFund(workspaceId, 'fund-ys', { managed: true, status: 'harvesting' });
      expect(mockFundRepo.update).toHaveBeenCalled();
      expect(mockInvestorRepo.findByCanonicalName).not.toHaveBeenCalled();
    });

    it('updateFund allows unmarking managed regardless of investors', async () => {
      mockFundRepo.findById.mockResolvedValue(managedFund);
      mockInvestorRepo.findByCanonicalName.mockResolvedValue(investorRow);

      await service.updateFund(workspaceId, 'fund-ys', { managed: false });
      expect(mockFundRepo.update).toHaveBeenCalled();
    });
  });
});
