import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundService, FundNotFoundError, FundAssetNotFoundError } from './fundService';
import type { FundAssetRepository, FundRepository } from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';

describe('FundService', () => {
  let fundRepo: { findAll: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let fundAssetRepo: { findByFundId: ReturnType<typeof vi.fn>; findByFundIds: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let fundMetricsService: { recomputeAsset: ReturnType<typeof vi.fn> };
  let service: FundService;

  beforeEach(() => {
    fundRepo = { findAll: vi.fn(), findById: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    fundAssetRepo = { findByFundId: vi.fn(), findByFundIds: vi.fn(), findById: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    fundMetricsService = { recomputeAsset: vi.fn() };
    service = new FundService(
      fundRepo as unknown as FundRepository,
      fundAssetRepo as unknown as FundAssetRepository,
      fundMetricsService as unknown as FundMetricsService,
    );
  });

  it('listFunds delegates to fundRepo.findAll', async () => {
    fundRepo.findAll.mockResolvedValueOnce([{ id: 'f1' }]);
    expect(await service.listFunds()).toEqual([{ id: 'f1' }]);
  });

  it('getFund throws FundNotFoundError when missing', async () => {
    fundRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.getFund('missing')).rejects.toBeInstanceOf(FundNotFoundError);
  });

  it('getFund returns the fund when found', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', name: 'Fund I' });
    expect(await service.getFund('f1')).toEqual({ id: 'f1', name: 'Fund I' });
  });

  it('createFund delegates to fundRepo.insert', async () => {
    fundRepo.insert.mockResolvedValueOnce({ id: 'f1', name: 'Fund I' });
    const result = await service.createFund({ name: 'Fund I' } as never);
    expect(result).toEqual({ id: 'f1', name: 'Fund I' });
  });

  it('updateFund throws FundNotFoundError when the fund does not exist', async () => {
    fundRepo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateFund('missing', { name: 'x' })).rejects.toBeInstanceOf(
      FundNotFoundError,
    );
  });

  it('listAssetsForFunds fetches every fund in one batched repo call', async () => {
    const pairs = [
      { fundId: 'f1', asset: { id: 'a1' } },
      { fundId: 'f2', asset: { id: 'a2' } },
    ];
    fundAssetRepo.findByFundIds.mockResolvedValueOnce(pairs);

    expect(await service.listAssetsForFunds(['f1', 'f2'])).toEqual(pairs);
    expect(fundAssetRepo.findByFundIds).toHaveBeenCalledTimes(1);
    expect(fundAssetRepo.findByFundIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(fundAssetRepo.findByFundId).not.toHaveBeenCalled();
  });

  it('getAsset throws FundAssetNotFoundError when missing', async () => {
    fundAssetRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.getAsset('missing')).rejects.toBeInstanceOf(FundAssetNotFoundError);
  });

  it('addAsset inserts without scoping to fund, recomputes metrics, and returns the fresh asset', async () => {
    fundAssetRepo.insert.mockResolvedValueOnce({ id: 'a1' });
    fundAssetRepo.findById.mockResolvedValueOnce({ id: 'a1', gross_moic: 1.2 });

    const result = await service.addAsset({ asset_type: 'cash' } as never);

    expect(fundAssetRepo.insert).toHaveBeenCalledWith({ asset_type: 'cash' });
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ id: 'a1', gross_moic: 1.2 });
  });

  it('updateAsset throws FundAssetNotFoundError when the asset does not exist', async () => {
    fundAssetRepo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateAsset('missing', { status: 'exited' })).rejects.toBeInstanceOf(
      FundAssetNotFoundError,
    );
    expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
  });

  it('updateAsset recomputes metrics and returns the fresh asset on success', async () => {
    fundAssetRepo.update.mockResolvedValueOnce({ id: 'a1' });
    // updateAsset calls getAsset() both before (to read is_manually_overridden)
    // and after the update, so findById must resolve on every call, not just once.
    fundAssetRepo.findById.mockResolvedValue({ id: 'a1', status: 'exited' });

    const result = await service.updateAsset('a1', { status: 'exited' });

    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('a1', false);
    expect(result).toEqual({ id: 'a1', status: 'exited' });
  });

  it('deleteFund throws FundNotFoundError and does not call fundRepo.delete when the fund does not exist', async () => {
    fundRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteFund('missing')).rejects.toBeInstanceOf(FundNotFoundError);
    expect(fundRepo.delete).not.toHaveBeenCalled();
  });

  it('deleteFund deletes the fund once it is confirmed to exist', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
    await service.deleteFund('f1');
    expect(fundRepo.delete).toHaveBeenCalledWith('f1');
  });

  it('deleteAsset throws FundAssetNotFoundError and does not call fundAssetRepo.delete when the asset does not exist', async () => {
    fundAssetRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteAsset('missing')).rejects.toBeInstanceOf(FundAssetNotFoundError);
    expect(fundAssetRepo.delete).not.toHaveBeenCalled();
  });

  it('deleteAsset deletes the asset once it is confirmed to exist', async () => {
    fundAssetRepo.findById.mockResolvedValueOnce({ id: 'a1' });
    await service.deleteAsset('a1');
    expect(fundAssetRepo.delete).toHaveBeenCalledWith('a1');
  });
});
