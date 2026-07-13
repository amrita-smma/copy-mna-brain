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

  /** Every stake whose parent fund belongs to this workspace. */
  async findAll(): Promise<Tables<'fund_holding_entity_stakes'>[]> {
    const rows = await this.db
      .select({ stake: fundHoldingEntityStakes })
      .from(fundHoldingEntityStakes)
      .innerJoin(funds, eq(fundHoldingEntityStakes.fund_id, funds.id))
      .where(eq(funds.workspace_id, this.workspaceId));
    return rows.map((r) => r.stake);
  }

  async findByFundHoldingEntity(
    fundId: string,
    holdingEntityId: string,
  ): Promise<Tables<'fund_holding_entity_stakes'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundHoldingEntityStakes)
      .where(
        and(
          eq(fundHoldingEntityStakes.fund_id, fundId),
          eq(fundHoldingEntityStakes.holding_entity_id, holdingEntityId),
        ),
      )
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<Tables<'fund_holding_entity_stakes'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundHoldingEntityStakes)
      .where(eq(fundHoldingEntityStakes.id, id))
      .limit(1);
    return row;
  }

  /** Upsert a (fund_id, holding_entity_id) stake. Delete-then-insert rather than
   * ON CONFLICT: the DB unique key is 3-column (fund_id, holding_entity_id,
   * funding_source_id) and our stakes carry a NULL funding_source_id, which
   * Postgres treats as distinct — so a conflict target wouldn't dedupe them. */
  async upsert(
    data: TablesInsert<'fund_holding_entity_stakes'>,
  ): Promise<Tables<'fund_holding_entity_stakes'>> {
    if (data.holding_entity_id) {
      await this.db
        .delete(fundHoldingEntityStakes)
        .where(
          and(
            eq(fundHoldingEntityStakes.fund_id, data.fund_id),
            eq(fundHoldingEntityStakes.holding_entity_id, data.holding_entity_id),
          ),
        );
    }
    const [row] = await this.db.insert(fundHoldingEntityStakes).values(data).returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(fundHoldingEntityStakes).where(eq(fundHoldingEntityStakes.id, id));
  }
}
