import { and, asc, eq, type SQL } from 'drizzle-orm';
import { fundInvestorCommitmentEvents, funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export interface FindCommitmentEventsFilter {
  fundId?: string;
  holdingEntityId?: string;
}

// An LP / investment-entity's commitment events in a fund. Child of `funds`
// (workspace root) via `fund_id`, so scoped by joining through `funds`.
export class FundInvestorCommitmentEventRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  /** Find all commitment events scoped to this workspace with optional filtering. */
  async findAll(
    filter?: FindCommitmentEventsFilter,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>[]> {
    const conditions: SQL[] = [eq(funds.workspace_id, this.workspaceId)];
    if (filter?.fundId) {
      conditions.push(eq(fundInvestorCommitmentEvents.fund_id, filter.fundId));
    }
    if (filter?.holdingEntityId) {
      conditions.push(eq(fundInvestorCommitmentEvents.holding_entity_id, filter.holdingEntityId));
    }

    const rows = await this.getExecutor(executor)
      .select({ event: fundInvestorCommitmentEvents })
      .from(fundInvestorCommitmentEvents)
      .innerJoin(funds, eq(fundInvestorCommitmentEvents.fund_id, funds.id))
      .where(and(...conditions))
      .orderBy(
        asc(fundInvestorCommitmentEvents.effective_date),
        asc(fundInvestorCommitmentEvents.created_at),
        asc(fundInvestorCommitmentEvents.id),
      );

    return rows.map((r) => r.event);
  }

  async findByFundAndHoldingEntity(
    fundId: string,
    holdingEntityId: string,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ event: fundInvestorCommitmentEvents })
      .from(fundInvestorCommitmentEvents)
      .innerJoin(funds, eq(fundInvestorCommitmentEvents.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundInvestorCommitmentEvents.fund_id, fundId),
          eq(fundInvestorCommitmentEvents.holding_entity_id, holdingEntityId),
        ),
      )
      .orderBy(
        asc(fundInvestorCommitmentEvents.effective_date),
        asc(fundInvestorCommitmentEvents.created_at),
        asc(fundInvestorCommitmentEvents.id),
      );

    return rows.map((r) => r.event);
  }

  async findByFundId(
    fundId: string,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ event: fundInvestorCommitmentEvents })
      .from(fundInvestorCommitmentEvents)
      .innerJoin(funds, eq(fundInvestorCommitmentEvents.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundInvestorCommitmentEvents.fund_id, fundId),
        ),
      )
      .orderBy(
        asc(fundInvestorCommitmentEvents.effective_date),
        asc(fundInvestorCommitmentEvents.created_at),
        asc(fundInvestorCommitmentEvents.id),
      );

    return rows.map((r) => r.event);
  }

  async findByTransferGroupId(
    transferGroupId: string,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ event: fundInvestorCommitmentEvents })
      .from(fundInvestorCommitmentEvents)
      .innerJoin(funds, eq(fundInvestorCommitmentEvents.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundInvestorCommitmentEvents.transfer_group_id, transferGroupId),
        ),
      )
      .orderBy(
        asc(fundInvestorCommitmentEvents.effective_date),
        asc(fundInvestorCommitmentEvents.created_at),
        asc(fundInvestorCommitmentEvents.id),
      );

    return rows.map((r) => r.event);
  }

  async findById(
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'> | undefined> {
    const rows = await this.getExecutor(executor)
      .select({ event: fundInvestorCommitmentEvents })
      .from(fundInvestorCommitmentEvents)
      .innerJoin(funds, eq(fundInvestorCommitmentEvents.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundInvestorCommitmentEvents.id, id),
        ),
      )
      .limit(1);

    return rows[0]?.event;
  }

  async insert(
    data: TablesInsert<'fund_investor_commitment_events'>,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>> {
    const [row] = await this.getExecutor(executor)
      .insert(fundInvestorCommitmentEvents)
      .values(data)
      .returning();
    return row;
  }

  async insertMany(
    data: TablesInsert<'fund_investor_commitment_events'>[],
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'>[]> {
    if (data.length === 0) return [];
    return this.getExecutor(executor)
      .insert(fundInvestorCommitmentEvents)
      .values(data)
      .returning();
  }

  async update(
    id: string,
    updates: TablesUpdate<'fund_investor_commitment_events'>,
    executor?: DbClient,
  ): Promise<Tables<'fund_investor_commitment_events'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(fundInvestorCommitmentEvents)
      .set({ ...updates, updated_at: new Date().toISOString() })
      .where(eq(fundInvestorCommitmentEvents.id, id))
      .returning();
    return row;
  }

  async delete(id: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
      .delete(fundInvestorCommitmentEvents)
      .where(eq(fundInvestorCommitmentEvents.id, id));
  }

  async deleteByTransferGroupId(transferGroupId: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
      .delete(fundInvestorCommitmentEvents)
      .where(eq(fundInvestorCommitmentEvents.transfer_group_id, transferGroupId));
  }

  async deleteByFundAndHoldingEntity(
    fundId: string,
    holdingEntityId: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(fundInvestorCommitmentEvents)
      .where(
        and(
          eq(fundInvestorCommitmentEvents.fund_id, fundId),
          eq(fundInvestorCommitmentEvents.holding_entity_id, holdingEntityId),
        ),
      );
  }
}
