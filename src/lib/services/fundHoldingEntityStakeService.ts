import type {
  FundHoldingEntityStakeRepository,
  FundRepository,
  HoldingEntityRepository,
  Tables,
} from '@/lib/repositories';

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
  ) {}

  listStakes(): Promise<Tables<'fund_holding_entity_stakes'>[]> {
    return this.stakeRepo.findAll();
  }

  /** Upsert a stake, validating both the fund and holdingEntity belong to the
   * workspace (the repos are workspace-scoped, so a miss means out-of-scope). */
  async upsertStake(input: UpsertStakeInput): Promise<Tables<'fund_holding_entity_stakes'>> {
    const [fund, holdingEntity] = await Promise.all([
      this.fundRepo.findById(input.fundId),
      this.holdingEntityRepo.findById(input.holdingEntityId),
    ]);
    if (!fund) throw new FundHoldingEntityStakeScopeError(`Fund ${input.fundId} not found`);
    if (!holdingEntity) {
      throw new FundHoldingEntityStakeScopeError(`HoldingEntity ${input.holdingEntityId} not found`);
    }
    return this.stakeRepo.upsert({
      fund_id: input.fundId,
      holding_entity_id: input.holdingEntityId,
      commitment_amount: input.commitmentAmount,
      commitment_amount_currency: input.commitmentAmountCurrency,
      invested_amount: input.investedAmount,
      invested_amount_currency: input.investedAmountCurrency,
    });
  }

  async deleteStake(id: string): Promise<void> {
    const existing = await this.stakeRepo.findById(id);
    if (!existing) throw new FundHoldingEntityStakeNotFoundError(id);
    // Confirm the parent fund is in-workspace before deleting.
    const fund = await this.fundRepo.findById(existing.fund_id);
    if (!fund) throw new FundHoldingEntityStakeNotFoundError(id);
    await this.stakeRepo.delete(id);
  }
}
