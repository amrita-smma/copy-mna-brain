import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FundAssetLedgerService,
  InvalidTransactionError,
  LastTransactionDeleteError,
  TransactionNotFoundError,
  ValuationNotFoundError,
} from './fundAssetLedgerService';
import type {
  DbClient,
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
} from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';

describe('FundAssetLedgerService', () => {
  let db: {
    transaction: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let transactionRepo: {
    findByFundAssetId: ReturnType<typeof vi.fn>;
    findBySourceDivestmentTxnId: ReturnType<typeof vi.fn>;
    deleteBySourceDivestmentTxnId: ReturnType<typeof vi.fn>;
    upsertLinkedCashMovement: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let valuationRepo: {
    findByFundAssetId: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let fundMetricsService: {
    recomputeAsset: ReturnType<typeof vi.fn>;
    recomputeFund: ReturnType<typeof vi.fn>;
  };
  let fundAssetRepo: {
    findByFundId: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let fundRepo: {
    findById: ReturnType<typeof vi.fn>;
  };
  let service: FundAssetLedgerService;

  beforeEach(() => {
    transactionRepo = {
      findByFundAssetId: vi.fn(),
      findBySourceDivestmentTxnId: vi.fn(),
      deleteBySourceDivestmentTxnId: vi.fn(),
      upsertLinkedCashMovement: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    valuationRepo = {
      findByFundAssetId: vi.fn(),
      findById: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    fundMetricsService = {
      recomputeAsset: vi.fn(),
      recomputeFund: vi.fn(),
    };
    fundAssetRepo = {
      findByFundId: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockImplementation((data) => Promise.resolve({ id: 'cash-new', ...data })),
    };
    fundRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'fund-1', name: 'Alpha Fund' }),
    };
    db = {
      transaction: vi.fn(async (cb) =>
        cb({
          select: vi.fn(),
          from: vi.fn(),
          where: vi.fn(),
          insert: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        }),
      ),
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    // Non-transactional fallback for unit tests mocking repos directly
    service = new FundAssetLedgerService(
      {} as unknown as DbClient,
      'workspace-1',
      transactionRepo as unknown as FundAssetTransactionRepository,
      valuationRepo as unknown as FundAssetValuationRepository,
      fundAssetRepo as unknown as FundAssetRepository,
      fundRepo as unknown as FundRepository,
      fundMetricsService as unknown as FundMetricsService,
    );
  });

  it('listTransactions delegates to transactionRepo.findByFundAssetId', async () => {
    transactionRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 't1' }]);
    expect(await service.listTransactions('a1')).toEqual([{ id: 't1' }]);
  });

  it('addTransaction inserts scoped to the asset, normalizes non-divestment destination to null, and recomputes metrics', async () => {
    transactionRepo.insert.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a1' });

    const result = await service.addTransaction('a1', {
      txn_date: '2026-07-08',
      txn_type: 'contribution',
      sell_proceeds_destination: 'cash_in_fund' as never,
    } as never);

    expect(transactionRepo.insert).toHaveBeenCalledWith({
      txn_date: '2026-07-08',
      txn_type: 'contribution',
      fund_asset_id: 'a1',
      sell_proceeds_destination: null,
    });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
    expect(result).toEqual({ id: 't1', fund_asset_id: 'a1' });
  });

  it('addTransaction accepts divestment with sell_proceeds_destination', async () => {
    transactionRepo.insert.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    });

    const result = await service.addTransaction('a1', {
      txn_date: '2026-07-08',
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    } as never);

    expect(transactionRepo.insert).toHaveBeenCalledWith({
      txn_date: '2026-07-08',
      txn_type: 'divestment',
      fund_asset_id: 'a1',
      sell_proceeds_destination: 'distributed_to_investor',
    });
    expect(result).toEqual({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    });
  });

  it('addTransaction rejects divestment without sell_proceeds_destination', async () => {
    await expect(
      service.addTransaction('a1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
      } as never),
    ).rejects.toBeInstanceOf(InvalidTransactionError);
    expect(transactionRepo.insert).not.toHaveBeenCalled();
  });

  it('addTransaction rejects divestment with invalid sell_proceeds_destination string', async () => {
    await expect(
      service.addTransaction('a1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'invalid_destination' as never,
      } as never),
    ).rejects.toThrowError(InvalidTransactionError);
    expect(transactionRepo.insert).not.toHaveBeenCalled();
  });

  it('deleteTransaction refuses to delete the asset\'s last remaining transaction', async () => {
    transactionRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 't1' }]);

    await expect(service.deleteTransaction('a1', 't1')).rejects.toBeInstanceOf(
      LastTransactionDeleteError,
    );
    expect(transactionRepo.delete).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('deleteTransaction deletes and recomputes metrics when more than one transaction remains', async () => {
    transactionRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);

    await service.deleteTransaction('a1', 't1');

    expect(transactionRepo.delete).toHaveBeenCalledWith('t1');
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
  });

  it('deleteTransaction throws TransactionNotFoundError when the id does not belong to this asset', async () => {
    transactionRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);

    await expect(service.deleteTransaction('a1', 't-other-asset')).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    expect(transactionRepo.delete).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('updateTransaction updates and recomputes metrics', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    });
    transactionRepo.update.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a1', notes: 'edited' });

    const result = await service.updateTransaction('a1', 't1', { notes: 'edited' });

    expect(transactionRepo.update).toHaveBeenCalledWith('t1', {
      notes: 'edited',
      sell_proceeds_destination: null,
    });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
    expect(result).toEqual({ id: 't1', fund_asset_id: 'a1', notes: 'edited' });
  });

  it('updateTransaction preserves sell_proceeds_destination on unrelated edits to divestment', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      fund_id: 'f1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
    });
    transactionRepo.update.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      fund_id: 'f1',
      txn_type: 'divestment',
      notes: 'new note',
      sell_proceeds_destination: 'cash_in_fund',
    });

    const result = await service.updateTransaction('a1', 't1', { notes: 'new note' });

    expect(transactionRepo.update).toHaveBeenCalledWith('t1', {
      notes: 'new note',
      sell_proceeds_destination: 'cash_in_fund',
    });
    expect(result).toMatchObject({ sell_proceeds_destination: 'cash_in_fund' });
  });

  it('updateTransaction clears sell_proceeds_destination when changing away from divestment', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
    });
    transactionRepo.update.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    });

    await service.updateTransaction('a1', 't1', { txn_type: 'contribution' });

    expect(transactionRepo.update).toHaveBeenCalledWith('t1', {
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    });
  });

  it('updateTransaction throws InvalidTransactionError when changing to divestment without a destination', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    });

    await expect(
      service.updateTransaction('a1', 't1', { txn_type: 'divestment' }),
    ).rejects.toBeInstanceOf(InvalidTransactionError);
    expect(transactionRepo.update).not.toHaveBeenCalled();
  });

  it('updateTransaction succeeds when changing to divestment with a destination', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    });
    transactionRepo.update.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    });

    await service.updateTransaction('a1', 't1', {
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    });

    expect(transactionRepo.update).toHaveBeenCalledWith('t1', {
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    });
  });

  it('updateTransaction throws InvalidTransactionError when clearing destination on an existing divestment', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      fund_id: 'f1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
    });

    await expect(
      service.updateTransaction('a1', 't1', { sell_proceeds_destination: null }),
    ).rejects.toBeInstanceOf(InvalidTransactionError);
    expect(transactionRepo.update).not.toHaveBeenCalled();
  });

  it('updateTransaction throws InvalidTransactionError when updating with invalid destination string', async () => {
    transactionRepo.findById.mockResolvedValueOnce({
      id: 't1',
      fund_asset_id: 'a1',
      fund_id: 'f1',
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
    });

    await expect(
      service.updateTransaction('a1', 't1', {
        sell_proceeds_destination: 'invalid_destination' as never,
      }),
    ).rejects.toThrowError(InvalidTransactionError);
    expect(transactionRepo.update).not.toHaveBeenCalled();
  });

  it('updateTransaction throws TransactionNotFoundError when the transaction does not exist', async () => {
    transactionRepo.findById.mockResolvedValueOnce(undefined);

    await expect(service.updateTransaction('a1', 'missing', {})).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    expect(transactionRepo.update).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('updateTransaction throws TransactionNotFoundError when the transaction belongs to a different asset', async () => {
    transactionRepo.findById.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a2' });

    await expect(service.updateTransaction('a1', 't1', { notes: 'x' })).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    expect(transactionRepo.update).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('listValuations delegates to valuationRepo.findByFundAssetId', async () => {
    valuationRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 'v1' }]);
    expect(await service.listValuations('a1')).toEqual([{ id: 'v1' }]);
  });

  it('upsertValuation upserts scoped to the asset and recomputes metrics', async () => {
    valuationRepo.upsert.mockResolvedValueOnce({ id: 'v1', fund_asset_id: 'a1' });

    const result = await service.upsertValuation('a1', { as_of_date: '2026-06-30' } as never);

    expect(valuationRepo.upsert).toHaveBeenCalledWith({
      as_of_date: '2026-06-30',
      fund_asset_id: 'a1',
    });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
    expect(result).toEqual({ id: 'v1', fund_asset_id: 'a1' });
  });

  it('deleteValuation deletes and recomputes metrics', async () => {
    valuationRepo.findById.mockResolvedValueOnce({ id: 'v1', fund_asset_id: 'a1' });

    await service.deleteValuation('a1', 'v1');

    expect(valuationRepo.delete).toHaveBeenCalledWith('v1');
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
  });

  it('deleteValuation throws ValuationNotFoundError when the valuation does not exist', async () => {
    valuationRepo.findById.mockResolvedValueOnce(undefined);

    await expect(service.deleteValuation('a1', 'missing')).rejects.toBeInstanceOf(
      ValuationNotFoundError,
    );
    expect(valuationRepo.delete).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('deleteValuation throws ValuationNotFoundError when the valuation belongs to a different asset', async () => {
    valuationRepo.findById.mockResolvedValueOnce({ id: 'v1', fund_asset_id: 'a2' });

    await expect(service.deleteValuation('a1', 'v1')).rejects.toBeInstanceOf(ValuationNotFoundError);
    expect(valuationRepo.delete).not.toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  describe('cash_in_fund linked cash movements (Phase 1)', () => {
    it('addTransaction rejects cash_in_fund divestment when fund_id is missing', async () => {
      await expect(
        service.addTransaction('a1', {
          txn_date: '2026-07-08',
          txn_type: 'divestment',
          sell_proceeds_destination: 'cash_in_fund',
          fund_id: null,
        } as never),
      ).rejects.toBeInstanceOf(InvalidTransactionError);
      expect(transactionRepo.insert).not.toHaveBeenCalled();
    });

    it('addTransaction creates linked cash movement and recomputes both assets and fund', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-asset-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
        txn_currency: 'USD',
        fx_rate: 1,
        holding_entity_id: 'entity-1',
        funding_source_id: 'source-1',
        notes: 'Exit sale',
      });
      transactionRepo.upsertLinkedCashMovement.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-1',
      });

      const result = await service.addTransaction('comp-1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        fund_id: 'fund-1',
        value_amount: 300000,
        txn_currency: 'USD',
        fx_rate: 1,
        holding_entity_id: 'entity-1',
        funding_source_id: 'source-1',
        notes: 'Exit sale',
      });

      expect(result.id).toBe('sale-1');
      expect(transactionRepo.upsertLinkedCashMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_asset_id: 'cash-asset-1',
          fund_id: 'fund-1',
          source_divestment_txn_id: 'sale-1',
          txn_date: '2026-07-08',
          txn_type: 'internal_transfer',
          value_amount: 300000,
          txn_currency: 'USD',
          fx_rate: 1,
          holding_entity_id: 'entity-1',
          funding_source_id: 'source-1',
        }),
      );
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
    });

    it('addTransaction with missing holding entity / source passes null attribution', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-asset-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'sale-2',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 150000,
        txn_currency: 'USD',
        fx_rate: 1,
        holding_entity_id: null,
        funding_source_id: null,
      });

      await service.addTransaction('comp-1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        fund_id: 'fund-1',
        value_amount: 150000,
      });

      expect(transactionRepo.upsertLinkedCashMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: null,
          funding_source_id: null,
          value_amount: 150000,
        }),
      );
    });

    it('updateTransaction updates linked cash movement when amount is edited', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
      });
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-1',
        source_divestment_txn_id: 'sale-1',
      });
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-asset-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.update.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 320000,
      });

      await service.updateTransaction('comp-1', 'sale-1', { value_amount: 320000 });

      expect(transactionRepo.upsertLinkedCashMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          value_amount: 320000,
          source_divestment_txn_id: 'sale-1',
        }),
      );
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
    });

    it('updateTransaction moves linked cash movement and recomputes both funds when fund_id changes', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-a',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
      });
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-a',
        source_divestment_txn_id: 'sale-1',
      });
      // Fund B cash asset resolution
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-asset-b', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.update.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-b',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
      });

      await service.updateTransaction('comp-1', 'sale-1', { fund_id: 'fund-b' });

      expect(transactionRepo.upsertLinkedCashMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_asset_id: 'cash-asset-b',
          fund_id: 'fund-b',
          source_divestment_txn_id: 'sale-1',
        }),
      );
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-b', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-a', true);
      expect(fundMetricsService.recomputeFund).toHaveBeenCalledWith('fund-a');
    });

    it('updateTransaction removes linked cash movement when destination changes to distributed_to_investor', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
      });
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-1',
        source_divestment_txn_id: 'sale-1',
      });
      transactionRepo.update.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        value_amount: 300000,
      });

      await service.updateTransaction('comp-1', 'sale-1', {
        sell_proceeds_destination: 'distributed_to_investor',
      });

      expect(transactionRepo.deleteBySourceDivestmentTxnId).toHaveBeenCalledWith('sale-1');
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
    });

    it('updateTransaction removes linked cash movement when txn_type changes away from divestment', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 300000,
      });
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-1',
        source_divestment_txn_id: 'sale-1',
      });
      transactionRepo.update.mockResolvedValueOnce({
        id: 'sale-1',
        fund_asset_id: 'comp-1',
        fund_id: 'fund-1',
        txn_type: 'contribution',
        sell_proceeds_destination: null,
        value_amount: 300000,
      });

      await service.updateTransaction('comp-1', 'sale-1', { txn_type: 'contribution' });

      expect(transactionRepo.deleteBySourceDivestmentTxnId).toHaveBeenCalledWith('sale-1');
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
    });

    it('deleteTransaction deletes linked cash movement and recomputes cash asset and fund', async () => {
      transactionRepo.findByFundAssetId.mockResolvedValueOnce([
        { id: 'sale-1', fund_asset_id: 'comp-1', fund_id: 'fund-1' },
        { id: 't-other', fund_asset_id: 'comp-1', fund_id: 'fund-1' },
      ]);
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce({
        id: 'cash-mov-1',
        fund_asset_id: 'cash-asset-1',
        source_divestment_txn_id: 'sale-1',
      });

      await service.deleteTransaction('comp-1', 'sale-1');

      expect(transactionRepo.deleteBySourceDivestmentTxnId).toHaveBeenCalledWith('sale-1');
      expect(transactionRepo.delete).toHaveBeenCalledWith('sale-1');
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('comp-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
      expect(fundMetricsService.recomputeFund).toHaveBeenCalledWith('fund-1');
    });

    it('resolveCashAsset creates fund-specific deterministic Cash account when none exists', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([]);
      fundRepo.findById.mockResolvedValueOnce({ id: 'fund-1', name: 'Alpha Fund' });
      fundAssetRepo.insert.mockResolvedValueOnce({
        id: 'new-cash-usd',
        asset_type: 'cash',
        asset_name: 'Cash - Alpha Fund (USD)',
        investment_currency: 'USD',
      });

      const cashAsset = await service.resolveCashAsset('fund-1', 'USD');

      expect(cashAsset.id).toBe('new-cash-usd');
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_type: 'cash',
          asset_name: 'Cash - Alpha Fund (USD)',
          investment_currency: 'USD',
          report_currency: 'USD',
        }),
      );
    });

    it('resolveCashAsset isolates two funds in the same currency into separate cash assets', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([]); // Fund A has no cash asset yet
      fundRepo.findById.mockResolvedValueOnce({ id: 'fund-a', name: 'Fund A' });
      fundAssetRepo.insert.mockResolvedValueOnce({
        id: 'cash-fund-a',
        asset_type: 'cash',
        asset_name: 'Cash - Fund A (USD)',
        investment_currency: 'USD',
      });

      const cashAssetA = await service.resolveCashAsset('fund-a', 'USD');
      expect(cashAssetA.id).toBe('cash-fund-a');
      expect(cashAssetA.asset_name).toBe('Cash - Fund A (USD)');

      fundAssetRepo.findByFundId.mockResolvedValueOnce([]); // Fund B has no cash asset yet
      fundRepo.findById.mockResolvedValueOnce({ id: 'fund-b', name: 'Fund B' });
      fundAssetRepo.insert.mockResolvedValueOnce({
        id: 'cash-fund-b',
        asset_type: 'cash',
        asset_name: 'Cash - Fund B (USD)',
        investment_currency: 'USD',
      });

      const cashAssetB = await service.resolveCashAsset('fund-b', 'USD');
      expect(cashAssetB.id).toBe('cash-fund-b');
      expect(cashAssetB.asset_name).toBe('Cash - Fund B (USD)');
      expect(cashAssetA.id).not.toBe(cashAssetB.id);
    });

    it('resolveCashAsset reuses single existing fund cash asset', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'horizon-reserve', asset_type: 'cash', asset_name: 'Horizon Reserve', investment_currency: 'USD' },
      ]);

      const cashAsset = await service.resolveCashAsset('fund-1', 'USD');

      expect(cashAsset.id).toBe('horizon-reserve');
      expect(fundAssetRepo.insert).not.toHaveBeenCalled();
    });

    it('resolveCashAsset prefers matching default name when multiple cash assets exist for the fund', async () => {
      fundRepo.findById.mockResolvedValueOnce({ id: 'fund-1', name: 'Alpha Fund' });
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'c1', asset_type: 'cash', asset_name: 'Petty Cash', investment_currency: 'USD' },
        { id: 'c2', asset_type: 'cash', asset_name: 'Cash - Alpha Fund (USD)', investment_currency: 'USD' },
      ]);

      const cashAsset = await service.resolveCashAsset('fund-1', 'USD');

      expect(cashAsset.id).toBe('c2');
      expect(fundAssetRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('generated internal_transfer and source link protections (Issue 3)', () => {
    it('addTransaction rejects direct creation of internal_transfer', async () => {
      await expect(
        service.addTransaction('comp-1', {
          txn_date: '2026-07-08',
          txn_type: 'internal_transfer',
          value_amount: 100000,
        } as never),
      ).rejects.toThrow('internal_transfer transactions cannot be created directly');
    });

    it('addTransaction rejects direct manual setting of source_divestment_txn_id', async () => {
      await expect(
        service.addTransaction('comp-1', {
          txn_date: '2026-07-08',
          txn_type: 'contribution',
          value_amount: 100000,
          source_divestment_txn_id: 'sale-1',
        } as never),
      ).rejects.toThrow('source_divestment_txn_id cannot be set manually');
    });

    it('updateTransaction rejects editing an existing internal_transfer transaction', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 't-transfer',
        fund_asset_id: 'cash-1',
        txn_type: 'internal_transfer',
      });

      await expect(
        service.updateTransaction('cash-1', 't-transfer', { value_amount: 200000 }),
      ).rejects.toThrow('Generated internal_transfer transactions cannot be edited directly');
    });

    it('updateTransaction rejects converting a transaction to internal_transfer', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 't-contrib',
        fund_asset_id: 'comp-1',
        txn_type: 'contribution',
      });

      await expect(
        service.updateTransaction('comp-1', 't-contrib', { txn_type: 'internal_transfer' as never }),
      ).rejects.toThrow('Transactions cannot be converted to internal_transfer');
    });

    it('updateTransaction rejects modifying source_divestment_txn_id directly', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 't-contrib',
        fund_asset_id: 'comp-1',
        txn_type: 'contribution',
      });

      await expect(
        service.updateTransaction('comp-1', 't-contrib', { source_divestment_txn_id: 'other-id' } as never),
      ).rejects.toThrow('source_divestment_txn_id cannot be modified directly');
    });

    it('deleteTransaction rejects direct deletion of an internal_transfer transaction', async () => {
      transactionRepo.findByFundAssetId.mockResolvedValueOnce([
        { id: 't-transfer', fund_asset_id: 'cash-1', txn_type: 'internal_transfer' },
        { id: 't2', fund_asset_id: 'cash-1', txn_type: 'contribution' },
      ]);

      await expect(
        service.deleteTransaction('cash-1', 't-transfer'),
      ).rejects.toThrow('Generated internal_transfer transactions cannot be deleted directly');
    });
  });

  describe('transactional atomicity & rollback (Issue 1)', () => {
    it('executes database writes inside transaction and rolls back on failure without computing metrics', async () => {
      const txMockDb = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockRejectedValueOnce(new Error('DB Constraint Violation')),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
      };

      const transactionalDb = {
        transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          return cb(txMockDb);
        }),
      };

      const txService = new FundAssetLedgerService(
        transactionalDb as unknown as DbClient,
        'workspace-1',
        transactionRepo as unknown as FundAssetTransactionRepository,
        valuationRepo as unknown as FundAssetValuationRepository,
        fundAssetRepo as unknown as FundAssetRepository,
        fundRepo as unknown as FundRepository,
        fundMetricsService as unknown as FundMetricsService,
      );

      await expect(
        txService.addTransaction('comp-1', {
          txn_date: '2026-07-08',
          txn_type: 'divestment',
          sell_proceeds_destination: 'cash_in_fund',
          fund_id: 'fund-1',
          value_amount: 100000,
        }),
      ).rejects.toThrow('DB Constraint Violation');

      // Metric recomputation must NOT run when transaction fails
      expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
      expect(transactionalDb.transaction).toHaveBeenCalled();
    });
  });

  describe('fund_of_funds divestment (Phase 1)', () => {
    it('accepts divestment on a fund_of_funds asset with distributed_to_investor and inserts no linked cash movement', async () => {
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'fof-divest-1',
        fund_asset_id: 'fof-asset-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        value_amount: 500000,
        txn_currency: 'USD',
      });

      const result = await service.addTransaction('fof-asset-1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        fund_id: 'fund-1',
        value_amount: 500000,
        txn_currency: 'USD',
      });

      expect(result.id).toBe('fof-divest-1');
      expect(transactionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_asset_id: 'fof-asset-1',
          txn_type: 'divestment',
          sell_proceeds_destination: 'distributed_to_investor',
        }),
      );
      expect(transactionRepo.upsertLinkedCashMovement).not.toHaveBeenCalled();
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('fof-asset-1', true);
    });

    it('accepts divestment on a fund_of_funds asset with cash_in_fund + fund_id, resolves cash asset, and inserts internal_transfer', async () => {
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-asset-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'fof-divest-2',
        fund_asset_id: 'fof-asset-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 500000,
        txn_currency: 'USD',
        fx_rate: 1,
        holding_entity_id: 'entity-1',
        funding_source_id: 'source-1',
        notes: 'FoF distribution retained in fund',
      });
      transactionRepo.upsertLinkedCashMovement.mockResolvedValueOnce({
        id: 'cash-mov-2',
        fund_asset_id: 'cash-asset-1',
      });

      const result = await service.addTransaction('fof-asset-1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        fund_id: 'fund-1',
        value_amount: 500000,
        txn_currency: 'USD',
        fx_rate: 1,
        holding_entity_id: 'entity-1',
        funding_source_id: 'source-1',
        notes: 'FoF distribution retained in fund',
      });

      expect(result.id).toBe('fof-divest-2');
      expect(transactionRepo.upsertLinkedCashMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_asset_id: 'cash-asset-1',
          fund_id: 'fund-1',
          source_divestment_txn_id: 'fof-divest-2',
          txn_date: '2026-07-08',
          txn_type: 'internal_transfer',
          value_amount: 500000,
          txn_currency: 'USD',
          fx_rate: 1,
          holding_entity_id: 'entity-1',
          funding_source_id: 'source-1',
        }),
      );
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('fof-asset-1', true);
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-asset-1', true);
    });

    it('rejects cash_in_fund divestment on a fund_of_funds asset without fund_id with InvalidTransactionError', async () => {
      await expect(
        service.addTransaction('fof-asset-1', {
          txn_date: '2026-07-08',
          txn_type: 'divestment',
          sell_proceeds_destination: 'cash_in_fund',
          fund_id: null,
          value_amount: 500000,
        } as never),
      ).rejects.toBeInstanceOf(InvalidTransactionError);
      expect(transactionRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('cash asset self-referencing divestment protection (Phase 3)', () => {
    it('addTransaction rejects cash_in_fund divestment on a cash asset resolving to itself and does not insert linked movement', async () => {
      // The fund's cash asset is cash-1 itself
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'txn-cash-divest',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 100000,
        txn_currency: 'USD',
      });

      await expect(
        service.addTransaction('cash-1', {
          txn_date: '2026-07-08',
          txn_type: 'divestment',
          sell_proceeds_destination: 'cash_in_fund',
          fund_id: 'fund-1',
          value_amount: 100000,
          txn_currency: 'USD',
        }),
      ).rejects.toThrowError(
        /cash_in_fund is not valid for a cash asset: proceeds would transfer to the same asset/i,
      );

      expect(transactionRepo.upsertLinkedCashMovement).not.toHaveBeenCalled();
    });

    it('addTransaction accepts distributed_to_investor divestment on a cash asset without linked movement', async () => {
      transactionRepo.insert.mockResolvedValueOnce({
        id: 'txn-cash-divest-dist',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        value_amount: 100000,
        txn_currency: 'USD',
      });

      const result = await service.addTransaction('cash-1', {
        txn_date: '2026-07-08',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        fund_id: 'fund-1',
        value_amount: 100000,
        txn_currency: 'USD',
      });

      expect(result.id).toBe('txn-cash-divest-dist');
      expect(transactionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_asset_id: 'cash-1',
          txn_type: 'divestment',
          sell_proceeds_destination: 'distributed_to_investor',
        }),
      );
      expect(transactionRepo.upsertLinkedCashMovement).not.toHaveBeenCalled();
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-1', true);
    });

    it('updateTransaction rejects changing to cash_in_fund divestment on a cash asset resolving to itself', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 't-cash-1',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_type: 'contribution',
        sell_proceeds_destination: null,
      });
      fundAssetRepo.findByFundId.mockResolvedValueOnce([
        { id: 'cash-1', asset_type: 'cash', investment_currency: 'USD', report_currency: 'USD' },
      ]);
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce(undefined);
      transactionRepo.update.mockResolvedValueOnce({
        id: 't-cash-1',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
        value_amount: 50000,
        txn_currency: 'USD',
      });

      await expect(
        service.updateTransaction('cash-1', 't-cash-1', {
          txn_type: 'divestment',
          sell_proceeds_destination: 'cash_in_fund',
          fund_id: 'fund-1',
          value_amount: 50000,
        }),
      ).rejects.toThrowError(
        /cash_in_fund is not valid for a cash asset: proceeds would transfer to the same asset/i,
      );

      expect(transactionRepo.upsertLinkedCashMovement).not.toHaveBeenCalled();
    });

    it('updateTransaction accepts changing to distributed_to_investor divestment on a cash asset', async () => {
      transactionRepo.findById.mockResolvedValueOnce({
        id: 't-cash-2',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_type: 'contribution',
        sell_proceeds_destination: null,
      });
      transactionRepo.findBySourceDivestmentTxnId.mockResolvedValueOnce(undefined);
      transactionRepo.update.mockResolvedValueOnce({
        id: 't-cash-2',
        fund_asset_id: 'cash-1',
        fund_id: 'fund-1',
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        value_amount: 50000,
        txn_currency: 'USD',
      });

      const result = await service.updateTransaction('cash-1', 't-cash-2', {
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
        fund_id: 'fund-1',
        value_amount: 50000,
      });

      expect(result.id).toBe('t-cash-2');
      expect(transactionRepo.upsertLinkedCashMovement).not.toHaveBeenCalled();
      expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('cash-1', true);
    });
  });
});
