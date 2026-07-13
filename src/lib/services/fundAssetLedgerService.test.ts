import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FundAssetLedgerService,
  LastTransactionDeleteError,
  TransactionNotFoundError,
  ValuationNotFoundError,
} from './fundAssetLedgerService';
import type { FundAssetTransactionRepository, FundAssetValuationRepository } from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';

describe('FundAssetLedgerService', () => {
  let transactionRepo: { findByFundAssetId: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let valuationRepo: { findByFundAssetId: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let fundMetricsService: { recomputeAsset: ReturnType<typeof vi.fn> };
  let service: FundAssetLedgerService;

  beforeEach(() => {
    transactionRepo = { findByFundAssetId: vi.fn(), findById: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    valuationRepo = { findByFundAssetId: vi.fn(), findById: vi.fn(), upsert: vi.fn(), delete: vi.fn() };
    fundMetricsService = { recomputeAsset: vi.fn() };
    service = new FundAssetLedgerService(
      transactionRepo as unknown as FundAssetTransactionRepository,
      valuationRepo as unknown as FundAssetValuationRepository,
      fundMetricsService as unknown as FundMetricsService,
    );
  });

  it('listTransactions delegates to transactionRepo.findByFundAssetId', async () => {
    transactionRepo.findByFundAssetId.mockResolvedValueOnce([{ id: 't1' }]);
    expect(await service.listTransactions('a1')).toEqual([{ id: 't1' }]);
  });

  it('addTransaction inserts scoped to the asset and recomputes metrics', async () => {
    transactionRepo.insert.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a1' });

    const result = await service.addTransaction('a1', {
      txn_date: '2026-07-08',
      txn_type: 'contribution',
    } as never);

    expect(transactionRepo.insert).toHaveBeenCalledWith({
      txn_date: '2026-07-08',
      txn_type: 'contribution',
      fund_asset_id: 'a1',
    });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
    expect(result).toEqual({ id: 't1', fund_asset_id: 'a1' });
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
    transactionRepo.findById.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a1' });
    transactionRepo.update.mockResolvedValueOnce({ id: 't1', fund_asset_id: 'a1', notes: 'edited' });

    const result = await service.updateTransaction('a1', 't1', { notes: 'edited' });

    expect(transactionRepo.update).toHaveBeenCalledWith('t1', { notes: 'edited' });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', true);
    expect(result).toEqual({ id: 't1', fund_asset_id: 'a1', notes: 'edited' });
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
});
