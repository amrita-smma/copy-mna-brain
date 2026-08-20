import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FundCommitmentEventService,
  calculateChronologicalRunningBalances,
  FundCommitmentEventNotFoundError,
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
} from './fundCommitmentEventService';

describe('calculateChronologicalRunningBalances', () => {
  it('correctly calculates running balances for positive additions and reductions', () => {
    const events = [
      {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
        counterparty_holding_entity_id: null,
        transfer_group_id: null,
        notes: null,
        source: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-02-01',
        event_type: 'additional_commitment',
        amount: 50,
        currency: 'USD',
        counterparty_holding_entity_id: null,
        transfer_group_id: null,
        notes: null,
        source: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'e3',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-03-01',
        event_type: 'reduction',
        amount: 20,
        currency: 'USD',
        counterparty_holding_entity_id: null,
        transfer_group_id: null,
        notes: null,
        source: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
    ];

    const result = calculateChronologicalRunningBalances(events as never, 'h1', 'f1');
    expect(result.currentBalance).toBe(130);
    expect(result.currency).toBe('USD');
    expect(result.eventBalances).toHaveLength(3);
    expect(result.eventBalances[0].runningBalance).toBe(100);
    expect(result.eventBalances[1].runningBalance).toBe(150);
    expect(result.eventBalances[2].runningBalance).toBe(130);
  });

  it('recalculates running balance correctly when events are out of order (backdated)', () => {
    const events = [
      {
        id: 'e3',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-03-01',
        event_type: 'additional_commitment',
        amount: 50,
        currency: 'USD',
        created_at: '2026-03-01T00:00:00Z',
      },
      {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-02-01',
        event_type: 'additional_commitment',
        amount: 30,
        currency: 'USD',
        created_at: '2026-02-01T00:00:00Z',
      },
    ];

    const result = calculateChronologicalRunningBalances(events as never, 'h1', 'f1');
    expect(result.currentBalance).toBe(180);
    expect(result.eventBalances[0].id).toBe('e1');
    expect(result.eventBalances[0].runningBalance).toBe(100);
    expect(result.eventBalances[1].id).toBe('e2');
    expect(result.eventBalances[1].runningBalance).toBe(130);
    expect(result.eventBalances[2].id).toBe('e3');
    expect(result.eventBalances[2].runningBalance).toBe(180);
  });

  it('rejects sequence that produces a negative balance at any point', () => {
    const events = [
      {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 50,
        currency: 'USD',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-02-01',
        event_type: 'reduction',
        amount: 100,
        currency: 'USD',
        created_at: '2026-02-01T00:00:00Z',
      },
    ];

    expect(() => calculateChronologicalRunningBalances(events as never, 'h1', 'f1')).toThrow(
      CommitmentNegativeBalanceError,
    );
  });

  it('rejects mixed currencies within a single ledger', () => {
    const events = [
      {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
      },
      {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-02-01',
        event_type: 'additional_commitment',
        amount: 50,
        currency: 'EUR',
      },
    ];

    expect(() => calculateChronologicalRunningBalances(events as never, 'h1', 'f1')).toThrow(
      InvalidCommitmentEventError,
    );
  });

  it('rejects non-positive event amounts', () => {
    const events = [
      {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 0,
        currency: 'USD',
      },
    ];

    expect(() => calculateChronologicalRunningBalances(events as never, 'h1', 'f1')).toThrow(
      InvalidCommitmentEventError,
    );
  });
});

describe('FundCommitmentEventService', () => {
  let mockDb: {
    transaction: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };
  let mockCommitmentEventRepo: {
    findAll: ReturnType<typeof vi.fn>;
    findByFundAndHoldingEntity: ReturnType<typeof vi.fn>;
    findByFundId: ReturnType<typeof vi.fn>;
    findByTransferGroupId: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteByTransferGroupId: ReturnType<typeof vi.fn>;
  };
  let mockStakeRepo: {
    findByFundHoldingEntity: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mockFundRepo: {
    findById: ReturnType<typeof vi.fn>;
  };
  let mockHoldingEntityRepo: {
    findById: ReturnType<typeof vi.fn>;
  };
  let service: FundCommitmentEventService;

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (cb) => cb(mockDb)),
      execute: vi.fn().mockResolvedValue(undefined),
    };
    mockCommitmentEventRepo = {
      findAll: vi.fn(),
      findByFundAndHoldingEntity: vi.fn().mockResolvedValue([]),
      findByFundId: vi.fn(),
      findByTransferGroupId: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteByTransferGroupId: vi.fn(),
    };
    mockStakeRepo = {
      findByFundHoldingEntity: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    mockFundRepo = {
      findById: vi.fn(),
    };
    mockHoldingEntityRepo = {
      findById: vi.fn(),
    };

    service = new FundCommitmentEventService(
      mockDb as never,
      'workspace-1',
      mockCommitmentEventRepo as never,
      mockStakeRepo as never,
      mockFundRepo as never,
      mockHoldingEntityRepo as never,
    );
  });

  describe('createEvent', () => {
    it('throws when transfer_in or transfer_out is passed to generic createEvent', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
      mockHoldingEntityRepo.findById.mockResolvedValueOnce({ id: 'h1' });

      await expect(
        service.createEvent({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'transfer_in',
          amount: 100,
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
    });

    it('throws when caller supplies a transferGroupId to generic createEvent', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
      mockHoldingEntityRepo.findById.mockResolvedValueOnce({ id: 'h1' });

      await expect(
        service.createEvent({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'additional_commitment',
          amount: 100,
          transferGroupId: 'forged-group-id',
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
    });

    it('throws when event currency does not match existing ledger currency', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
      mockHoldingEntityRepo.findById.mockResolvedValueOnce({ id: 'h1' });
      mockCommitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValueOnce([
        {
          id: 'e1',
          fund_id: 'f1',
          holding_entity_id: 'h1',
          effective_date: '2026-01-01',
          event_type: 'initial_commitment',
          amount: 100,
          currency: 'USD',
        },
      ]);

      await expect(
        service.createEvent({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-02-01',
          eventType: 'additional_commitment',
          amount: 50,
          currency: 'EUR',
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
    });

    it('creates an event, acquires advisory lock, recalculates running balances, and updates the stake', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1', base_currency: 'USD' });
      mockHoldingEntityRepo.findById.mockResolvedValueOnce({ id: 'h1' });

      const newEvent = {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'h1',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
      };
      mockCommitmentEventRepo.insert.mockResolvedValueOnce(newEvent);
      mockCommitmentEventRepo.findByFundAndHoldingEntity
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([newEvent]);
      mockStakeRepo.findByFundHoldingEntity.mockResolvedValueOnce(null);

      const result = await service.createEvent({
        fundId: 'f1',
        holdingEntityId: 'h1',
        effectiveDate: '2026-01-01',
        eventType: 'initial_commitment',
        amount: 100,
      });

      expect(result).toEqual(newEvent);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.execute).toHaveBeenCalled();
      expect(mockCommitmentEventRepo.insert).toHaveBeenCalledTimes(1);
      expect(mockStakeRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: 'f1',
          holding_entity_id: 'h1',
          commitment_amount: 100,
        }),
        expect.anything(),
      );
    });
  });

  describe('createTransfer', () => {
    it('creates linked transfer-out and transfer-in events atomically and acquires sorted locks', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
      mockHoldingEntityRepo.findById
        .mockResolvedValueOnce({ id: 'seller' })
        .mockResolvedValueOnce({ id: 'buyer' });

      const sellerExistingEvent = {
        id: 'e0',
        fund_id: 'f1',
        holding_entity_id: 'seller',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
      };

      const outEvent = {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'seller',
        effective_date: '2026-02-01',
        event_type: 'transfer_out',
        amount: 25,
        currency: 'USD',
        transfer_group_id: 'tg-1',
      };
      const inEvent = {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'buyer',
        effective_date: '2026-02-01',
        event_type: 'transfer_in',
        amount: 25,
        currency: 'USD',
        transfer_group_id: 'tg-1',
      };

      mockCommitmentEventRepo.insert
        .mockResolvedValueOnce(outEvent)
        .mockResolvedValueOnce(inEvent);

      mockCommitmentEventRepo.findByFundAndHoldingEntity
        .mockResolvedValueOnce([sellerExistingEvent]) // seller pre-check
        .mockResolvedValueOnce([]) // buyer pre-check
        .mockResolvedValueOnce([sellerExistingEvent, outEvent]) // seller stake recompute
        .mockResolvedValueOnce([inEvent]); // buyer stake recompute

      mockStakeRepo.findByFundHoldingEntity
        .mockResolvedValueOnce({ id: 's-seller', commitment_amount: 100 })
        .mockResolvedValueOnce(null);

      const result = await service.createTransfer({
        fundId: 'f1',
        fromHoldingEntityId: 'seller',
        toHoldingEntityId: 'buyer',
        effectiveDate: '2026-02-01',
        amount: 25,
        currency: 'USD',
      });

      expect(result.fromEvent).toEqual(outEvent);
      expect(result.toEvent).toEqual(inEvent);
      expect(result.transferGroupId).toBeDefined();

      // Seller stake updated to 75
      expect(mockStakeRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: 'seller',
          commitment_amount: 75,
        }),
        expect.anything(),
      );

      // Buyer stake updated to 25
      expect(mockStakeRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: 'buyer',
          commitment_amount: 25,
        }),
        expect.anything(),
      );
    });

    it('rejects transfer when currency does not match seller or buyer existing currency', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({ id: 'f1' });
      mockHoldingEntityRepo.findById
        .mockResolvedValueOnce({ id: 'seller' })
        .mockResolvedValueOnce({ id: 'buyer' });

      mockCommitmentEventRepo.findByFundAndHoldingEntity
        .mockResolvedValueOnce([
          {
            id: 'e0',
            fund_id: 'f1',
            holding_entity_id: 'seller',
            effective_date: '2026-01-01',
            event_type: 'initial_commitment',
            amount: 100,
            currency: 'USD',
          },
        ])
        .mockResolvedValueOnce([]);

      await expect(
        service.createTransfer({
          fundId: 'f1',
          fromHoldingEntityId: 'seller',
          toHoldingEntityId: 'buyer',
          effectiveDate: '2026-02-01',
          amount: 25,
          currency: 'EUR',
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
    });
  });

  describe('updateEvent', () => {
    it('rejects attempt to change event type or counterparty on existing transfer', async () => {
      const existingTransfer = {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'seller',
        event_type: 'transfer_out',
        amount: 25,
        currency: 'USD',
        counterparty_holding_entity_id: 'buyer',
        transfer_group_id: 'tg-1',
      };
      mockCommitmentEventRepo.findById.mockResolvedValue(existingTransfer);

      await expect(
        service.updateEvent('e1', {
          eventType: 'additional_commitment',
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);

      await expect(
        service.updateEvent('e1', {
          counterpartyHoldingEntityId: 'different-buyer',
        }),
      ).rejects.toBeInstanceOf(InvalidCommitmentEventError);
    });
  });

  describe('deleteEvent', () => {
    it('deletes a transfer pair and restores balances for both parties', async () => {
      const outEvent = {
        id: 'e1',
        fund_id: 'f1',
        holding_entity_id: 'seller',
        transfer_group_id: 'tg-1',
      };
      const inEvent = {
        id: 'e2',
        fund_id: 'f1',
        holding_entity_id: 'buyer',
        transfer_group_id: 'tg-1',
      };

      mockCommitmentEventRepo.findById.mockResolvedValueOnce(outEvent);
      mockCommitmentEventRepo.findByTransferGroupId.mockResolvedValueOnce([outEvent, inEvent]);

      const sellerInitial = {
        id: 'e0',
        fund_id: 'f1',
        holding_entity_id: 'seller',
        effective_date: '2026-01-01',
        event_type: 'initial_commitment',
        amount: 100,
        currency: 'USD',
      };
      mockCommitmentEventRepo.findByFundAndHoldingEntity
        .mockResolvedValueOnce([sellerInitial])
        .mockResolvedValueOnce([]);

      mockStakeRepo.findByFundHoldingEntity
        .mockResolvedValueOnce({ id: 's-seller', commitment_amount: 75 })
        .mockResolvedValueOnce({ id: 's-buyer', commitment_amount: 25 });

      await service.deleteEvent('e1');

      expect(mockCommitmentEventRepo.deleteByTransferGroupId).toHaveBeenCalledWith(
        'tg-1',
        expect.anything(),
      );

      // Seller restored to 100
      expect(mockStakeRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: 'seller',
          commitment_amount: 100,
        }),
        expect.anything(),
      );

      // Buyer restored to 0
      expect(mockStakeRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: 'buyer',
          commitment_amount: 0,
        }),
        expect.anything(),
      );
    });
  });
});
