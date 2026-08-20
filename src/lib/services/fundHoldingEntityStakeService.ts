import type {
  FundHoldingEntityStakeRepository,
  FundInvestorCommitmentEventRepository,
  FundRepository,
  HoldingEntityRepository,
  Tables,
} from '@/lib/repositories';
import type { DbClient } from '@/lib/server/db';
import {
  calculateChronologicalRunningBalances,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
} from './fundCommitmentEventService';
import { acquireCommitmentLedgerLocks } from './fundCommitmentLock';

export class FundHoldingEntityStakeNotFoundError extends Error {
  constructor(id: string) {
    super(`Fund holdingEntity stake ${id} not found`);
    this.name = 'FundHoldingEntityStakeNotFoundError';
  }
}

export class FundHoldingEntityStakeScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundHoldingEntityStakeScopeError';
  }
}

export interface UpsertStakeInput {
  fundId: string;
  holdingEntityId: string;
  commitmentAmount?: number | null;
  commitmentAmountCurrency?: string;
  investedAmount?: number | null;
  investedAmountCurrency?: string;
}

/** LP / investment-entity stakes in funds — backs the by-investment-entity view. */
export class FundHoldingEntityStakeService {
  constructor(
    private readonly stakeRepo: FundHoldingEntityStakeRepository,
    private readonly fundRepo: FundRepository,
    private readonly holdingEntityRepo: HoldingEntityRepository,
    private readonly commitmentEventRepo?: FundInvestorCommitmentEventRepository,
    private readonly db?: DbClient,
  ) {}

  listStakes(): Promise<Tables<'fund_holding_entity_stakes'>[]> {
    return this.stakeRepo.findAll();
  }

  /** Upsert a stake, validating both the fund and holdingEntity belong to the
   * workspace (the repos are workspace-scoped, so a miss means out-of-scope).
   * Translates absolute commitment deltas into commitment events so history is preserved. */
  async upsertStake(input: UpsertStakeInput): Promise<Tables<'fund_holding_entity_stakes'>> {
    const [fund, holdingEntity] = await Promise.all([
      this.fundRepo.findById(input.fundId),
      this.holdingEntityRepo.findById(input.holdingEntityId),
    ]);
    if (!fund) throw new FundHoldingEntityStakeScopeError(`Fund ${input.fundId} not found`);
    if (!holdingEntity) {
      throw new FundHoldingEntityStakeScopeError(`HoldingEntity ${input.holdingEntityId} not found`);
    }

    const runInTransaction = async (txDb?: DbClient) => {
      if (txDb) {
        await acquireCommitmentLedgerLocks(txDb, input.fundId, [input.holdingEntityId]);
      }

      const existingStake = await this.stakeRepo.findByFundHoldingEntity(
        input.fundId,
        input.holdingEntityId,
        txDb,
      );

      let finalCommitmentAmount = input.commitmentAmount !== undefined
        ? input.commitmentAmount
        : existingStake?.commitment_amount;

      let currency =
        input.commitmentAmountCurrency ||
        existingStake?.commitment_amount_currency ||
        fund.base_currency ||
        'USD';

      if (this.commitmentEventRepo && input.commitmentAmount !== undefined) {
        const events = await this.commitmentEventRepo.findByFundAndHoldingEntity(
          input.fundId,
          input.holdingEntityId,
          txDb,
        );

        if (events.length > 0) {
          const ledgerCurrency = events[0].currency || 'USD';
          if (input.commitmentAmountCurrency && input.commitmentAmountCurrency !== ledgerCurrency) {
            throw new InvalidCommitmentEventError(
              `Currency mismatch: ledger for holding entity ${input.holdingEntityId} is in ${ledgerCurrency}, but upsert specified ${input.commitmentAmountCurrency}. Mixed currencies are not allowed.`,
            );
          }
          currency = ledgerCurrency;
        }

        let currentAmount = 0;
        if (events.length > 0) {
          const { currentBalance } = calculateChronologicalRunningBalances(
            events,
            input.holdingEntityId,
            input.fundId,
          );
          currentAmount = currentBalance;
        } else if (existingStake?.commitment_amount != null) {
          currentAmount = Number(existingStake.commitment_amount);
        }

        const targetAmount = input.commitmentAmount == null ? 0 : Number(input.commitmentAmount);
        if (targetAmount < 0) {
          throw new CommitmentNegativeBalanceError('Commitment amount cannot be negative');
        }

        const delta = Math.round((targetAmount - currentAmount) * 1e6) / 1e6;
        const today = new Date().toISOString().slice(0, 10);

        if (events.length === 0) {
          if (targetAmount > 0) {
            await this.commitmentEventRepo.insert(
              {
                fund_id: input.fundId,
                holding_entity_id: input.holdingEntityId,
                effective_date: today,
                event_type: 'initial_commitment',
                amount: targetAmount,
                currency,
                notes: 'Initial commitment',
                source: 'legacy_stake_upsert',
              },
              txDb,
            );
          }
        } else if (delta > 0) {
          await this.commitmentEventRepo.insert(
            {
              fund_id: input.fundId,
              holding_entity_id: input.holdingEntityId,
              effective_date: today,
              event_type: 'additional_commitment',
              amount: delta,
              currency,
              notes: 'Stake update',
              source: 'legacy_stake_upsert',
            },
            txDb,
          );
        } else if (delta < 0) {
          await this.commitmentEventRepo.insert(
            {
              fund_id: input.fundId,
              holding_entity_id: input.holdingEntityId,
              effective_date: today,
              event_type: 'reduction',
              amount: Math.abs(delta),
              currency,
              notes: 'Stake update',
              source: 'legacy_stake_upsert',
            },
            txDb,
          );
        }

        finalCommitmentAmount = targetAmount;
      }

      return this.stakeRepo.upsert(
        {
          id: existingStake?.id,
          fund_id: input.fundId,
          holding_entity_id: input.holdingEntityId,
          funding_source_id: existingStake?.funding_source_id,
          commitment_amount: finalCommitmentAmount,
          commitment_amount_currency: currency,
          invested_amount:
            input.investedAmount !== undefined
              ? input.investedAmount
              : existingStake?.invested_amount,
          invested_amount_currency:
            input.investedAmountCurrency ||
            existingStake?.invested_amount_currency ||
            currency,
        },
        txDb,
      );
    };

    if (this.db) {
      return this.db.transaction(async (tx) => {
        return runInTransaction(tx as unknown as DbClient);
      });
    }

    return runInTransaction();
  }

  async deleteStake(id: string): Promise<void> {
    const existing = await this.stakeRepo.findById(id);
    if (!existing) throw new FundHoldingEntityStakeNotFoundError(id);
    // Confirm the parent fund is in-workspace before deleting.
    const fund = await this.fundRepo.findById(existing.fund_id);
    if (!fund) throw new FundHoldingEntityStakeNotFoundError(id);

    const runDelete = async (txDb?: DbClient) => {
      if (txDb && existing.holding_entity_id) {
        await acquireCommitmentLedgerLocks(txDb, existing.fund_id, [existing.holding_entity_id]);
      }
      if (this.commitmentEventRepo && existing.holding_entity_id) {
        const events = await this.commitmentEventRepo.findByFundAndHoldingEntity(
          existing.fund_id,
          existing.holding_entity_id,
          txDb,
        );
        const hasTransfers = events.some((e) => e.transfer_group_id != null);
        if (hasTransfers) {
          throw new FundHoldingEntityStakeScopeError(
            'Cannot delete a stake with linked transfer events. Remove the transfers first.',
          );
        }
        await this.commitmentEventRepo.deleteByFundAndHoldingEntity(
          existing.fund_id,
          existing.holding_entity_id,
          txDb,
        );
      }
      await this.stakeRepo.delete(id, txDb);
    };

    if (this.db) {
      await this.db.transaction(async (tx) => {
        await runDelete(tx as unknown as DbClient);
      });
    } else {
      await runDelete();
    }
  }
}
