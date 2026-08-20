import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FundHoldingEntityStakeService,
  FundHoldingEntityStakeNotFoundError,
  FundHoldingEntityStakeScopeError,
} from './fundHoldingEntityStakeService';
import { InvalidCommitmentEventError } from './fundCommitmentEventService';
import type {
  FundHoldingEntityStakeRepository,
  FundInvestorCommitmentEventRepository,
  FundRepository,
  HoldingEntityRepository,
} from '@/lib/repositories';

describe('FundHoldingEntityStakeService', () => {
  let stakeRepo: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByFundHoldingEntity: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let commitmentEventRepo: {
    findByFundAndHoldingEntity: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    deleteByFundAndHoldingEntity: ReturnType<typeof vi.fn>;
  };
  let fundRepo: { findById: ReturnType<typeof vi.fn> };
  let holdingEntityRepo: { findById: ReturnType<typeof vi.fn> };
  let mockDb: { transaction: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
  let service: FundHoldingEntityStakeService;

  beforeEach(() => {
    stakeRepo = {
      findAll: vi.fn(),
      findById: vi.fn(),
      findByFundHoldingEntity: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    commitmentEventRepo = {
      findByFundAndHoldingEntity: vi.fn().mockResolvedValue([]),
      insert: vi.fn(),
      deleteByFundAndHoldingEntity: vi.fn(),
    };
    fundRepo = { findById: vi.fn() };
    holdingEntityRepo = { findById: vi.fn() };
    mockDb = {
      transaction: vi.fn(async (cb) => cb(mockDb)),
      execute: vi.fn().mockResolvedValue(undefined),
    };
    service = new FundHoldingEntityStakeService(
      stakeRepo as unknown as FundHoldingEntityStakeRepository,
      fundRepo as unknown as FundRepository,
      holdingEntityRepo as unknown as HoldingEntityRepository,
      commitmentEventRepo as unknown as FundInvestorCommitmentEventRepository,
      mockDb as never,
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

  it('upsertStake throws when input currency does not match existing ledger currency', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([
      {
        id: 'e1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 1_000_000,
        currency: 'USD',
      },
    ]);

    await expect(
      service.upsertStake({
        fundId: 'f1',
        holdingEntityId: 'i1',
        commitmentAmount: 1_500_000,
        commitmentAmountCurrency: 'EUR',
      }),
    ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
  });

  it('upsertStake writes initial event when no ledger exists', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    stakeRepo.findByFundHoldingEntity.mockResolvedValueOnce(null);
    commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([]);
    stakeRepo.upsert.mockResolvedValueOnce({ id: 's1', fund_id: 'f1', holding_entity_id: 'i1' });

    const result = await service.upsertStake({
      fundId: 'f1',
      holdingEntityId: 'i1',
      commitmentAmount: 2_000_000,
    });

    expect(result).toEqual({ id: 's1', fund_id: 'f1', holding_entity_id: 'i1' });
    expect(commitmentEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        fund_id: 'f1',
        holding_entity_id: 'i1',
        event_type: 'initial_commitment',
        amount: 2_000_000,
      }),
      expect.anything(),
    );
  });

  it('upsertStake translates positive delta into additional_commitment event', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    stakeRepo.findByFundHoldingEntity.mockResolvedValueOnce({ id: 's1', commitment_amount: 1_000_000 });
    commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([
      {
        id: 'e1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 1_000_000,
        currency: 'USD',
      },
    ]);
    stakeRepo.upsert.mockResolvedValueOnce({ id: 's1', commitment_amount: 1_500_000 });

    await service.upsertStake({
      fundId: 'f1',
      holdingEntityId: 'i1',
      commitmentAmount: 1_500_000,
    });

    expect(commitmentEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'additional_commitment',
        amount: 500_000,
      }),
      expect.anything(),
    );
  });

  it('upsertStake translates negative delta into reduction event', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    stakeRepo.findByFundHoldingEntity.mockResolvedValueOnce({ id: 's1', commitment_amount: 1_000_000 });
    commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([
      {
        id: 'e1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 1_000_000,
        currency: 'USD',
      },
    ]);
    stakeRepo.upsert.mockResolvedValueOnce({ id: 's1', commitment_amount: 800_000 });

    await service.upsertStake({
      fundId: 'f1',
      holdingEntityId: 'i1',
      commitmentAmount: 800_000,
    });

    expect(commitmentEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'reduction',
        amount: 200_000,
      }),
      expect.anything(),
    );
  });

  it('upsertStake does not create an event when commitment amount is unchanged', async () => {
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
    holdingEntityRepo.findById.mockResolvedValueOnce({ id: 'i1' });
    stakeRepo.findByFundHoldingEntity.mockResolvedValueOnce({ id: 's1', commitment_amount: 1_000_000 });
    commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([
      {
        id: 'e1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 1_000_000,
        currency: 'USD',
      },
    ]);
    stakeRepo.upsert.mockResolvedValueOnce({ id: 's1', commitment_amount: 1_000_000 });

    await service.upsertStake({
      fundId: 'f1',
      holdingEntityId: 'i1',
      commitmentAmount: 1_000_000,
    });

    expect(commitmentEventRepo.insert).not.toHaveBeenCalled();
  });

  it('deleteStake throws FundHoldingEntityStakeNotFoundError when missing', async () => {
    stakeRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteStake('missing')).rejects.toBeInstanceOf(
      FundHoldingEntityStakeNotFoundError,
    );
    expect(stakeRepo.delete).not.toHaveBeenCalled();
  });

  it('deleteStake deletes stake and cleans up associated events', async () => {
    stakeRepo.findById.mockResolvedValueOnce({ id: 's1', fund_id: 'f1', holding_entity_id: 'i1' });
    fundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
    await service.deleteStake('s1');

    expect(commitmentEventRepo.deleteByFundAndHoldingEntity).toHaveBeenCalledWith(
      'f1',
      'i1',
      expect.anything(),
    );
    expect(stakeRepo.delete).toHaveBeenCalledWith('s1', expect.anything());
  });
});
