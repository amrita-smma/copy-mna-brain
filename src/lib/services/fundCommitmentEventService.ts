import type {
  FundInvestorCommitmentEventRepository,
  FundHoldingEntityStakeRepository,
  FundRepository,
  HoldingEntityRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';
import type { DbClient } from '@/lib/server/db';
import { acquireCommitmentLedgerLocks } from './fundCommitmentLock';

export class FundCommitmentEventNotFoundError extends Error {
  constructor(id: string) {
    super(`Fund commitment event ${id} not found`);
    this.name = 'FundCommitmentEventNotFoundError';
  }
}

export class FundCommitmentEventScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundCommitmentEventScopeError';
  }
}

export class CommitmentNegativeBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentNegativeBalanceError';
  }
}

export class InvalidCommitmentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommitmentEventError';
  }
}

export const COMMITMENT_EVENT_TYPES = [
  'initial_commitment',
  'additional_commitment',
  'reduction',
  'transfer_in',
  'transfer_out',
] as const;

export type CommitmentEventType = (typeof COMMITMENT_EVENT_TYPES)[number];

export function isCommitmentEventType(val: unknown): val is CommitmentEventType {
  return typeof val === 'string' && COMMITMENT_EVENT_TYPES.includes(val as CommitmentEventType);
}

export interface EventWithRunningBalance {
  id: string;
  fund_id: string;
  holding_entity_id: string;
  effective_date: string;
  event_type: CommitmentEventType;
  amount: number;
  currency: string;
  counterparty_holding_entity_id: string | null;
  transfer_group_id: string | null;
  notes: string | null;
  source: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  delta: number;
  runningBalance: number;
}

export function getCommitmentEventMultiplier(eventType: CommitmentEventType | string): number {
  switch (eventType) {
    case 'initial_commitment':
    case 'additional_commitment':
    case 'transfer_in':
      return 1;
    case 'reduction':
    case 'transfer_out':
      return -1;
    default:
      throw new InvalidCommitmentEventError(`Unknown commitment event type: ${eventType}`);
  }
}

export function calculateChronologicalRunningBalances(
  events: Tables<'fund_investor_commitment_events'>[],
  holdingEntityId?: string,
  fundId?: string,
): {
  eventBalances: EventWithRunningBalance[];
  currentBalance: number;
  currency: string;
} {
  const sorted = [...events].sort((a, b) => {
    if (a.effective_date !== b.effective_date) {
      return a.effective_date.localeCompare(b.effective_date);
    }
    const aCreated = a.created_at || '';
    const bCreated = b.created_at || '';
    if (aCreated !== bCreated) {
      return aCreated.localeCompare(bCreated);
    }
    return a.id.localeCompare(b.id);
  });

  let runningBalance = 0;
  const ledgerCurrency = events[0]?.currency || 'USD';
  const eventBalances: EventWithRunningBalance[] = [];

  for (const event of sorted) {
    const rawAmt = Number(event.amount);
    if (isNaN(rawAmt) || rawAmt <= 0) {
      throw new InvalidCommitmentEventError(
        `Commitment event amount must be positive, got ${event.amount}`,
      );
    }

    if (event.currency && event.currency !== ledgerCurrency) {
      throw new InvalidCommitmentEventError(
        `Mixed currencies in commitment ledger: expected ${ledgerCurrency}, found ${event.currency}`,
      );
    }

    const mult = getCommitmentEventMultiplier(event.event_type);
    const delta = mult * rawAmt;
    runningBalance += delta;

    if (runningBalance < -1e-6) {
      const entityStr = holdingEntityId || event.holding_entity_id;
      const fundStr = fundId || event.fund_id;
      throw new CommitmentNegativeBalanceError(
        `Commitment balance cannot be negative for holding entity ${entityStr} in fund ${fundStr} on date ${event.effective_date} (would be ${runningBalance})`,
      );
    }

    eventBalances.push({
      ...event,
      amount: rawAmt,
      event_type: event.event_type as CommitmentEventType,
      delta,
      runningBalance: Math.max(0, Math.round(runningBalance * 1e6) / 1e6),
    });
  }

  return {
    eventBalances,
    currentBalance: Math.max(0, Math.round(runningBalance * 1e6) / 1e6),
    currency: ledgerCurrency,
  };
}

export interface CreateCommitmentEventInput {
  fundId: string;
  holdingEntityId: string;
  effectiveDate: string;
  eventType: CommitmentEventType;
  amount: number;
  currency?: string;
  counterpartyHoldingEntityId?: string | null;
  transferGroupId?: string | null;
  notes?: string | null;
  source?: string | null;
  createdBy?: string | null;
}

export interface CreateCommitmentTransferInput {
  fundId: string;
  fromHoldingEntityId: string;
  toHoldingEntityId: string;
  effectiveDate: string;
  amount: number;
  currency?: string;
  notes?: string | null;
  createdBy?: string | null;
}

export interface UpdateCommitmentEventInput {
  effectiveDate?: string;
  eventType?: CommitmentEventType;
  amount?: number;
  currency?: string;
  notes?: string | null;
  counterpartyHoldingEntityId?: string | null;
  updatedBy?: string | null;
}

export class FundCommitmentEventService {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly commitmentEventRepo: FundInvestorCommitmentEventRepository,
    private readonly stakeRepo: FundHoldingEntityStakeRepository,
    private readonly fundRepo: FundRepository,
    private readonly holdingEntityRepo: HoldingEntityRepository,
  ) {}

  /** List events with calculated chronological running balances. */
  async listEvents(filter?: {
    fundId?: string;
    holdingEntityId?: string;
  }): Promise<EventWithRunningBalance[]> {
    const rawEvents = await this.commitmentEventRepo.findAll(filter);

    // Group by (fund_id, holding_entity_id) to calculate running balance per position
    const groups = new Map<string, Tables<'fund_investor_commitment_events'>[]>();
    for (const ev of rawEvents) {
      const key = `${ev.fund_id}:${ev.holding_entity_id}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(ev);
    }

    const allCalculated: EventWithRunningBalance[] = [];
    for (const [key, evList] of groups.entries()) {
      const [fId, hId] = key.split(':');
      const { eventBalances } = calculateChronologicalRunningBalances(evList, hId, fId);
      allCalculated.push(...eventBalances);
    }

    // Sort the final combined list chronologically
    return allCalculated.sort((a, b) => {
      if (a.effective_date !== b.effective_date) {
        return a.effective_date.localeCompare(b.effective_date);
      }
      const aCreated = a.created_at || '';
      const bCreated = b.created_at || '';
      if (aCreated !== bCreated) {
        return aCreated.localeCompare(bCreated);
      }
      return a.id.localeCompare(b.id);
    });
  }

  async getEvent(id: string): Promise<Tables<'fund_investor_commitment_events'>> {
    const event = await this.commitmentEventRepo.findById(id);
    if (!event) throw new FundCommitmentEventNotFoundError(id);
    return event;
  }

  /** Recompute running balance for (fund_id, holding_entity_id) and sync to stake table */
  private async recomputeStakeProjection(
    fundId: string,
    holdingEntityId: string,
    txDb: DbClient,
  ): Promise<number> {
    const events = await this.commitmentEventRepo.findByFundAndHoldingEntity(
      fundId,
      holdingEntityId,
      txDb,
    );

    const { currentBalance, currency } = calculateChronologicalRunningBalances(
      events,
      holdingEntityId,
      fundId,
    );

    const existingStake = await this.stakeRepo.findByFundHoldingEntity(
      fundId,
      holdingEntityId,
      txDb,
    );

    if (existingStake) {
      await this.stakeRepo.upsert(
        {
          id: existingStake.id,
          fund_id: fundId,
          holding_entity_id: holdingEntityId,
          funding_source_id: existingStake.funding_source_id,
          commitment_amount: currentBalance,
          commitment_amount_currency: currency || existingStake.commitment_amount_currency || 'USD',
          invested_amount: existingStake.invested_amount,
          invested_amount_currency: existingStake.invested_amount_currency,
        },
        txDb,
      );
    } else if (events.length > 0) {
      await this.stakeRepo.upsert(
        {
          fund_id: fundId,
          holding_entity_id: holdingEntityId,
          commitment_amount: currentBalance,
          commitment_amount_currency: currency || 'USD',
          invested_amount: 0,
          invested_amount_currency: currency || 'USD',
        },
        txDb,
      );
    }

    return currentBalance;
  }

  /** Create a single commitment event and sync stake atomically */
  async createEvent(
    input: CreateCommitmentEventInput,
  ): Promise<Tables<'fund_investor_commitment_events'>> {
    if (!input.amount || input.amount <= 0) {
      throw new InvalidCommitmentEventError('Commitment amount must be greater than 0');
    }
    if (!input.effectiveDate) {
      throw new InvalidCommitmentEventError('Effective date is required');
    }
    if (!isCommitmentEventType(input.eventType)) {
      throw new InvalidCommitmentEventError(`Invalid commitment event type: ${input.eventType}`);
    }
    if (input.eventType === 'transfer_in' || input.eventType === 'transfer_out') {
      throw new InvalidCommitmentEventError(
        'Transfers cannot be created via createEvent; use createTransfer instead.',
      );
    }
    if (input.transferGroupId) {
      throw new InvalidCommitmentEventError(
        'Caller-supplied transferGroupId is not allowed on createEvent.',
      );
    }

    const [fund, holdingEntity] = await Promise.all([
      this.fundRepo.findById(input.fundId),
      this.holdingEntityRepo.findById(input.holdingEntityId),
    ]);

    if (!fund) {
      throw new FundCommitmentEventScopeError(`Fund ${input.fundId} not found`);
    }
    if (!holdingEntity) {
      throw new FundCommitmentEventScopeError(`Holding entity ${input.holdingEntityId} not found`);
    }

    if (input.counterpartyHoldingEntityId) {
      const counterparty = await this.holdingEntityRepo.findById(input.counterpartyHoldingEntityId);
      if (!counterparty) {
        throw new FundCommitmentEventScopeError(
          `Counterparty holding entity ${input.counterpartyHoldingEntityId} not found`,
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const txDb = tx as unknown as DbClient;

      // Serialize mutations for this ledger position with an advisory lock
      await acquireCommitmentLedgerLocks(txDb, input.fundId, [input.holdingEntityId]);

      // Enforce single-currency ledger rule
      const existingEvents = await this.commitmentEventRepo.findByFundAndHoldingEntity(
        input.fundId,
        input.holdingEntityId,
        txDb,
      );

      const targetCurrency = input.currency || fund.base_currency || 'USD';
      if (existingEvents.length > 0) {
        const ledgerCurrency = existingEvents[0].currency || 'USD';
        if (targetCurrency !== ledgerCurrency) {
          throw new InvalidCommitmentEventError(
            `Currency mismatch: ledger for holding entity ${input.holdingEntityId} is in ${ledgerCurrency}, but event specified ${targetCurrency}. Mixed currencies are not allowed.`,
          );
        }
      }

      const event = await this.commitmentEventRepo.insert(
        {
          fund_id: input.fundId,
          holding_entity_id: input.holdingEntityId,
          effective_date: input.effectiveDate,
          event_type: input.eventType,
          amount: input.amount,
          currency: targetCurrency,
          counterparty_holding_entity_id: input.counterpartyHoldingEntityId || null,
          transfer_group_id: null,
          notes: input.notes || null,
          source: input.source || 'manual',
          created_by: input.createdBy || null,
        },
        txDb,
      );

      await this.recomputeStakeProjection(input.fundId, input.holdingEntityId, txDb);

      return event;
    });
  }

  /** Create a linked transfer pair atomically (transfer_out for seller, transfer_in for buyer) */
  async createTransfer(input: CreateCommitmentTransferInput): Promise<{
    transferGroupId: string;
    fromEvent: Tables<'fund_investor_commitment_events'>;
    toEvent: Tables<'fund_investor_commitment_events'>;
  }> {
    if (!input.amount || input.amount <= 0) {
      throw new InvalidCommitmentEventError('Transfer amount must be greater than 0');
    }
    if (!input.effectiveDate) {
      throw new InvalidCommitmentEventError('Effective date is required');
    }
    if (input.fromHoldingEntityId === input.toHoldingEntityId) {
      throw new InvalidCommitmentEventError('Seller and buyer holding entities must be different');
    }

    const [fund, fromEntity, toEntity] = await Promise.all([
      this.fundRepo.findById(input.fundId),
      this.holdingEntityRepo.findById(input.fromHoldingEntityId),
      this.holdingEntityRepo.findById(input.toHoldingEntityId),
    ]);

    if (!fund) {
      throw new FundCommitmentEventScopeError(`Fund ${input.fundId} not found`);
    }
    if (!fromEntity) {
      throw new FundCommitmentEventScopeError(
        `Seller holding entity ${input.fromHoldingEntityId} not found`,
      );
    }
    if (!toEntity) {
      throw new FundCommitmentEventScopeError(
        `Buyer holding entity ${input.toHoldingEntityId} not found`,
      );
    }

    const transferGroupId = crypto.randomUUID();
    const currency = input.currency || fund.base_currency || 'USD';

    return this.db.transaction(async (tx) => {
      const txDb = tx as unknown as DbClient;

      // Lock both participants in deterministic sorted order
      await acquireCommitmentLedgerLocks(txDb, input.fundId, [
        input.fromHoldingEntityId,
        input.toHoldingEntityId,
      ]);

      // Enforce currency matching across seller and buyer ledgers
      const [sellerEvents, buyerEvents] = await Promise.all([
        this.commitmentEventRepo.findByFundAndHoldingEntity(
          input.fundId,
          input.fromHoldingEntityId,
          txDb,
        ),
        this.commitmentEventRepo.findByFundAndHoldingEntity(
          input.fundId,
          input.toHoldingEntityId,
          txDb,
        ),
      ]);

      if (sellerEvents.length > 0) {
        const sellerCurrency = sellerEvents[0].currency || 'USD';
        if (sellerCurrency !== currency) {
          throw new InvalidCommitmentEventError(
            `Currency mismatch: seller ledger is in ${sellerCurrency}, but transfer specified ${currency}.`,
          );
        }
      }

      if (buyerEvents.length > 0) {
        const buyerCurrency = buyerEvents[0].currency || 'USD';
        if (buyerCurrency !== currency) {
          throw new InvalidCommitmentEventError(
            `Currency mismatch: buyer ledger is in ${buyerCurrency}, but transfer specified ${currency}.`,
          );
        }
      }

      // 1. Insert transfer_out for seller
      const fromEvent = await this.commitmentEventRepo.insert(
        {
          fund_id: input.fundId,
          holding_entity_id: input.fromHoldingEntityId,
          effective_date: input.effectiveDate,
          event_type: 'transfer_out',
          amount: input.amount,
          currency,
          counterparty_holding_entity_id: input.toHoldingEntityId,
          transfer_group_id: transferGroupId,
          notes: input.notes || null,
          source: 'manual_transfer',
          created_by: input.createdBy || null,
        },
        txDb,
      );

      // 2. Insert transfer_in for buyer
      const toEvent = await this.commitmentEventRepo.insert(
        {
          fund_id: input.fundId,
          holding_entity_id: input.toHoldingEntityId,
          effective_date: input.effectiveDate,
          event_type: 'transfer_in',
          amount: input.amount,
          currency,
          counterparty_holding_entity_id: input.fromHoldingEntityId,
          transfer_group_id: transferGroupId,
          notes: input.notes || null,
          source: 'manual_transfer',
          created_by: input.createdBy || null,
        },
        txDb,
      );

      // 3. Recompute and validate seller running balance (rejects if negative)
      await this.recomputeStakeProjection(input.fundId, input.fromHoldingEntityId, txDb);

      // 4. Recompute and validate buyer running balance
      await this.recomputeStakeProjection(input.fundId, input.toHoldingEntityId, txDb);

      return {
        transferGroupId,
        fromEvent,
        toEvent,
      };
    });
  }

  /** Update an existing commitment event */
  async updateEvent(
    id: string,
    updates: UpdateCommitmentEventInput,
  ): Promise<Tables<'fund_investor_commitment_events'>> {
    if (updates.amount !== undefined && updates.amount <= 0) {
      throw new InvalidCommitmentEventError('Commitment amount must be greater than 0');
    }
    if (updates.eventType !== undefined && !isCommitmentEventType(updates.eventType)) {
      throw new InvalidCommitmentEventError(`Invalid commitment event type: ${updates.eventType}`);
    }

    const existing = await this.commitmentEventRepo.findById(id);
    if (!existing) {
      throw new FundCommitmentEventNotFoundError(id);
    }

    return this.db.transaction(async (tx) => {
      const txDb = tx as unknown as DbClient;

      if (existing.transfer_group_id) {
        // Linked transfer: reject modifying eventType or counterparty
        if (updates.eventType !== undefined && updates.eventType !== existing.event_type) {
          throw new InvalidCommitmentEventError(
            'Cannot change event type of an existing transfer event. Delete the transfer and create a new one instead.',
          );
        }
        if (
          updates.counterpartyHoldingEntityId !== undefined &&
          updates.counterpartyHoldingEntityId !== existing.counterparty_holding_entity_id
        ) {
          throw new InvalidCommitmentEventError(
            'Cannot change counterparty of an existing transfer event. Delete the transfer and create a new one instead.',
          );
        }

        const linkedEvents = await this.commitmentEventRepo.findByTransferGroupId(
          existing.transfer_group_id,
          txDb,
        );

        if (linkedEvents.length === 0) {
          throw new FundCommitmentEventNotFoundError(id);
        }

        // Lock all participants in sorted order
        const participantIds = linkedEvents.map((e) => e.holding_entity_id);
        await acquireCommitmentLedgerLocks(txDb, existing.fund_id, participantIds);

        if (updates.currency !== undefined && updates.currency !== existing.currency) {
          throw new InvalidCommitmentEventError(
            `Cannot change transfer currency from ${existing.currency} to ${updates.currency}.`,
          );
        }

        const patch: Partial<TablesInsert<'fund_investor_commitment_events'>> = {};
        if (updates.amount !== undefined) patch.amount = updates.amount;
        if (updates.effectiveDate !== undefined) patch.effective_date = updates.effectiveDate;
        if (updates.notes !== undefined) patch.notes = updates.notes;
        if (updates.updatedBy !== undefined) patch.updated_by = updates.updatedBy;

        for (const ev of linkedEvents) {
          await this.commitmentEventRepo.update(ev.id, patch, txDb);
        }

        // Recompute all affected entities
        for (const ev of linkedEvents) {
          await this.recomputeStakeProjection(ev.fund_id, ev.holding_entity_id, txDb);
        }

        const updated = await this.commitmentEventRepo.findById(id, txDb);
        return updated!;
      }

      // Standalone event update
      if (updates.eventType === 'transfer_in' || updates.eventType === 'transfer_out') {
        throw new InvalidCommitmentEventError(
          'Cannot convert a standalone event into a transfer event. Use createTransfer instead.',
        );
      }

      if (updates.counterpartyHoldingEntityId) {
        const counterparty = await this.holdingEntityRepo.findById(
          updates.counterpartyHoldingEntityId,
        );
        if (!counterparty) {
          throw new FundCommitmentEventScopeError(
            `Counterparty holding entity ${updates.counterpartyHoldingEntityId} not found`,
          );
        }
      }

      // Lock entity ledger
      await acquireCommitmentLedgerLocks(txDb, existing.fund_id, [existing.holding_entity_id]);

      if (updates.currency !== undefined && updates.currency !== existing.currency) {
        throw new InvalidCommitmentEventError(
          `Cannot change event currency from ${existing.currency} to ${updates.currency}. Ledger must be single-currency.`,
        );
      }

      const patch: TablesUpdate<'fund_investor_commitment_events'> = {};
      if (updates.effectiveDate !== undefined) patch.effective_date = updates.effectiveDate;
      if (updates.eventType !== undefined) patch.event_type = updates.eventType;
      if (updates.amount !== undefined) patch.amount = updates.amount;
      if (updates.notes !== undefined) patch.notes = updates.notes;
      if (updates.counterpartyHoldingEntityId !== undefined) {
        patch.counterparty_holding_entity_id = updates.counterpartyHoldingEntityId;
      }
      if (updates.updatedBy !== undefined) patch.updated_by = updates.updatedBy;

      const updated = await this.commitmentEventRepo.update(id, patch, txDb);
      if (!updated) throw new FundCommitmentEventNotFoundError(id);

      await this.recomputeStakeProjection(existing.fund_id, existing.holding_entity_id, txDb);

      return updated;
    });
  }

  /** Delete a commitment event (or both events if part of a transfer) */
  async deleteEvent(id: string): Promise<void> {
    const existing = await this.commitmentEventRepo.findById(id);
    if (!existing) {
      throw new FundCommitmentEventNotFoundError(id);
    }

    await this.db.transaction(async (tx) => {
      const txDb = tx as unknown as DbClient;

      if (existing.transfer_group_id) {
        const linkedEvents = await this.commitmentEventRepo.findByTransferGroupId(
          existing.transfer_group_id,
          txDb,
        );
        if (linkedEvents.length === 0) {
          throw new FundCommitmentEventNotFoundError(id);
        }
        const participantIds = linkedEvents.map((e) => e.holding_entity_id);
        await acquireCommitmentLedgerLocks(txDb, existing.fund_id, participantIds);

        await this.commitmentEventRepo.deleteByTransferGroupId(existing.transfer_group_id, txDb);

        for (const ev of linkedEvents) {
          await this.recomputeStakeProjection(ev.fund_id, ev.holding_entity_id, txDb);
        }
      } else {
        await acquireCommitmentLedgerLocks(txDb, existing.fund_id, [existing.holding_entity_id]);
        await this.commitmentEventRepo.delete(id, txDb);
        await this.recomputeStakeProjection(existing.fund_id, existing.holding_entity_id, txDb);
      }
    });
  }
}
