import { and, eq } from 'drizzle-orm';
import { fundHoldingEntityStakes, funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

// An LP/investment-entity's commitment-based stake in a fund. The table has no
// own workspace_id — it's scoped by joining through `funds` (workspace root).
export class FundHoldingEntityStakeRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  /** Every stake whose parent fund belongs to this workspace. */
  async findAll(executor?: DbClient): Promise<Tables<'fund_holding_entity_stakes'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ stake: fundHoldingEntityStakes })
      .from(fundHoldingEntityStakes)
      .innerJoin(funds, eq(fundHoldingEntityStakes.fund_id, funds.id))
      .where(eq(funds.workspace_id, this.workspaceId));
    return rows.map((r) => r.stake);
  }

  async findByFundHoldingEntity(
    fundId: string,
    holdingEntityId: string,
    executor?: DbClient,
  ): Promise<Tables<'fund_holding_entity_stakes'> | undefined> {
    const [result] = await this.getExecutor(executor)
      .select({ stake: fundHoldingEntityStakes })
      .from(fundHoldingEntityStakes)
      .innerJoin(funds, eq(fundHoldingEntityStakes.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundHoldingEntityStakes.fund_id, fundId),
          eq(fundHoldingEntityStakes.holding_entity_id, holdingEntityId),
        ),
      )
      .limit(1);
    return result?.stake;
  }

  async findById(id: string, executor?: DbClient): Promise<Tables<'fund_holding_entity_stakes'> | undefined> {
    const [result] = await this.getExecutor(executor)
      .select({ stake: fundHoldingEntityStakes })
      .from(fundHoldingEntityStakes)
      .innerJoin(funds, eq(fundHoldingEntityStakes.fund_id, funds.id))
      .where(
        and(
          eq(funds.workspace_id, this.workspaceId),
          eq(fundHoldingEntityStakes.id, id),
        ),
      )
      .limit(1);
    return result?.stake;
  }

  /** Upsert a (fund_id, holding_entity_id) stake. Delete-then-insert rather than
   * ON CONFLICT: the DB unique key is 3-column (fund_id, holding_entity_id,
   * funding_source_id) and our stakes carry a NULL funding_source_id, which
   * Postgres treats as distinct — so a conflict target wouldn't dedupe them. */
  async upsert(
    data: TablesInsert<'fund_holding_entity_stakes'>,
    executor?: DbClient,
  ): Promise<Tables<'fund_holding_entity_stakes'>> {
    const exec = this.getExecutor(executor);
    let preservedCreatedAt: string | undefined;
    if (data.holding_entity_id) {
      const [existing] = await exec
        .select({ created_at: fundHoldingEntityStakes.created_at })
        .from(fundHoldingEntityStakes)
        .where(
          and(
            eq(fundHoldingEntityStakes.fund_id, data.fund_id),
            eq(fundHoldingEntityStakes.holding_entity_id, data.holding_entity_id),
          ),
        )
        .limit(1);
      if (existing?.created_at) {
        preservedCreatedAt = typeof existing.created_at === 'string'
          ? existing.created_at
          : (existing.created_at as Date).toISOString();
      }
      await exec
        .delete(fundHoldingEntityStakes)
        .where(
          and(
            eq(fundHoldingEntityStakes.fund_id, data.fund_id),
            eq(fundHoldingEntityStakes.holding_entity_id, data.holding_entity_id),
          ),
        );
    }
    const insertData = preservedCreatedAt
      ? { ...data, created_at: preservedCreatedAt }
      : data;
    const [row] = await exec.insert(fundHoldingEntityStakes).values(insertData).returning();
    return row;
  }

  async delete(id: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor).delete(fundHoldingEntityStakes).where(eq(fundHoldingEntityStakes.id, id));
  }
}
