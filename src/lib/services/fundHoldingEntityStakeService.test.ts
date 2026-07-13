import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FundHoldingEntityStakeService,
  FundHoldingEntityStakeNotFoundError,
  FundHoldingEntityStakeScopeError,
} from './fundHoldingEntityStakeService';
import type {
  FundHoldingEntityStakeRepository,
  FundRepository,
  HoldingEntityRepository,
} from '@/lib/repositories';

describe('FundHoldingEntityStakeService', () => {
  let stakeRepo: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let fundRepo: { findById: ReturnType<typeof vi.fn> };
  let holdingEntityRepo: { findById: ReturnType<typeof vi.fn> };
  let service: FundHoldingEntityStakeService;

  beforeEach(() => {
    stakeRepo = { findAll: vi.fn(), findById: vi.fn(), upsert: vi.fn(), delete: vi.fn() };
    fundRepo = { findById: vi.fn() };
    holdingEntityRepo = { findById: vi.fn() };
    service = new FundHoldingEntityStakeService(
      stakeRepo as unknown as FundHoldingEntityStakeRepository,
      fundRepo as unknown as FundRepository,
      holdingEntityRepo as unknown as HoldingEntityRepository,
    );
  });

  it('listStakes delegates to the repo', async () => {
    stakeRepo.findAll.mockResolvedValueOnce([{ id: 's1' }]);
    expect(await service.listStakes()).toEqual([{ id: 's1' }]);
  });

  it('upsertStake throws when the fund is out of scope', async () => {
    fundRepo.findById.mockResolvedValueOnce(undefined);
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    await expect(
      service.upsertStake({ fundId: 'f1', holdingEntityId: 'i1' }),
    ).rejects.toBeInstanceOf(FundHoldingEntityStakeScopeError);
    expect(stakeRepo.upsert).not.toHaveBeenCalled();
  });

  it('upsertStake throws when the investor is out of scope', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
    holdingEntityRepo.findById.mockResolvedValueOnce(undefined);
    await expect(
      service.upsertStake({ fundId: 'f1', holdingEntityId: 'i1' }),
    ).rejects.toBeInstanceOf(FundHoldingEntityStakeScopeError);
  });

  it('upsertStake writes when both fund and investor are in scope', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    stakeRepo.upsert.mockResolvedValueOnce({ id: 's1', fund_id: 'f1', holding_entity_id: 'i1' });

    const result = await service.upsertStake({
      fundId: 'f1',
      holdingEntityId: 'i1',
      commitmentAmount: 2_000_000,
    });

    expect(result).toEqual({ id: 's1', fund_id: 'f1', holding_entity_id: 'i1' });
    expect(stakeRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ fund_id: 'f1', holding_entity_id: 'i1', commitment_amount: 2_000_000 }),
    );
  });

  it('deleteStake throws FundHoldingEntityStakeNotFoundError when missing', async () => {
    stakeRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteStake('missing')).rejects.toBeInstanceOf(
      FundHoldingEntityStakeNotFoundError,
    );
    expect(stakeRepo.delete).not.toHaveBeenCalled();
  });

  it('deleteStake deletes once the stake and its in-scope fund are confirmed', async () => {
    stakeRepo.findById.mockResolvedValueOnce({ id: 's1', fund_id: 'f1' });
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
    await service.deleteStake('s1');
    expect(stakeRepo.delete).toHaveBeenCalledWith('s1');
  });
});
