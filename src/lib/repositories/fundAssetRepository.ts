import { and, eq, isNotNull, isNull, inArray } from 'drizzle-orm';
import { fundAssets, fundAssetTransactions } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FundAssetRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findByFundId(fundId: string): Promise<Tables<'fund_assets'>[]> {
    const rows = await this.db
      .select({ asset: fundAssets })
      .from(fundAssets)
      .innerJoin(fundAssetTransactions, eq(fundAssets.id, fundAssetTransactions.fund_asset_id))
      .where(
        and(
          eq(fundAssets.workspace_id, this.workspaceId),
          eq(fundAssetTransactions.fund_id, fundId),
        ),
      )
      .groupBy(fundAssets.id)
      .orderBy(fundAssets.asset_name, fundAssets.id);
    return rows.map((r) => r.asset);
  }

  /**
   * The batched counterpart to findByFundId: returns (fundId, asset) pairs for
   * every given fund in one query. A co-invested asset shared across funds
   * appears once per fund it belongs to — mirroring findByFundId run per fund.
   * Assets are ordered by name/id so callers can group by fund while keeping
   * each fund's assets in the same order the single-fund query returns.
   */
  async findByFundIds(
    fundIds: string[],
  ): Promise<Array<{ fundId: string; asset: Tables<'fund_assets'> }>> {
    if (fundIds.length === 0) return [];
    const rows = await this.db
      .select({ fundId: fundAssetTransactions.fund_id, asset: fundAssets })
      .from(fundAssets)
      .innerJoin(fundAssetTransactions, eq(fundAssets.id, fundAssetTransactions.fund_asset_id))
      .where(
        and(
          eq(fundAssets.workspace_id, this.workspaceId),
          inArray(fundAssetTransactions.fund_id, fundIds),
        ),
      )
      .groupBy(fundAssetTransactions.fund_id, fundAssets.id)
      .orderBy(fundAssets.asset_name, fundAssets.id);
    return rows.map((r) => ({ fundId: r.fundId as string, asset: r.asset }));
  }

  async findUnassignedAssets(): Promise<Tables<'fund_assets'>[]> {
    const rows = await this.db
      .select({ asset: fundAssets })
      .from(fundAssets)
      .leftJoin(
        fundAssetTransactions,
        and(
          eq(fundAssets.id, fundAssetTransactions.fund_asset_id),
          isNotNull(fundAssetTransactions.fund_id),
        ),
      )
      .where(
        and(
          eq(fundAssets.workspace_id, this.workspaceId),
          isNull(fundAssetTransactions.id),
        ),
      )
      .groupBy(fundAssets.id)
      .orderBy(fundAssets.asset_name, fundAssets.id);
    return rows.map((r) => r.asset);
  }

  async findById(id: string): Promise<Tables<'fund_assets'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundAssets)
      .where(and(eq(fundAssets.id, id), eq(fundAssets.workspace_id, this.workspaceId)))
      .limit(1);
    return row;
  }

  /** Every asset in this workspace (for fund-update matching). */
  async findAll(): Promise<Tables<'fund_assets'>[]> {
    return this.db
      .select()
      .from(fundAssets)
      .where(eq(fundAssets.workspace_id, this.workspaceId))
      .orderBy(fundAssets.asset_name, fundAssets.id);
  }

  async insert(
    data: Omit<TablesInsert<'fund_assets'>, 'workspace_id'>,
  ): Promise<Tables<'fund_assets'>> {
    const [row] = await this.db
      .insert(fundAssets)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'fund_assets'>,
  ): Promise<Tables<'fund_assets'> | undefined> {
    const [row] = await this.db
      .update(fundAssets)
      .set(updates)
      .where(and(eq(fundAssets.id, id), eq(fundAssets.workspace_id, this.workspaceId)))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(fundAssets)
      .where(and(eq(fundAssets.id, id), eq(fundAssets.workspace_id, this.workspaceId)));
  }

  /**
   * Atomically flips `ai_opinion_status` to 'failed' only if it is still
   * 'processing'. A single conditional UPDATE avoids the read-then-write gap
   * a `findById` + `update` pair would have against a concurrent tool write.
   */
  async markAiOpinionFailedIfProcessing(id: string): Promise<void> {
    await this.db
      .update(fundAssets)
      .set({ ai_opinion_status: 'failed' })
      .where(
        and(
          eq(fundAssets.id, id),
          eq(fundAssets.workspace_id, this.workspaceId),
          eq(fundAssets.ai_opinion_status, 'processing'),
        ),
      );
  }

  /**
   * Persist a completed AI Opinion only while the holding is still
   * `processing`. Prevents a cancelled/superseded workforce run from
   * resurrecting a verdict after `markAiOpinionFailedIfProcessing` (or a
   * newer dispatch) has already moved the row on.
   */
  async completeAiOpinionIfProcessing(
    id: string,
    updates: TablesUpdate<'fund_assets'>,
  ): Promise<Tables<'fund_assets'> | undefined> {
    const [row] = await this.db
      .update(fundAssets)
      .set(updates)
      .where(
        and(
          eq(fundAssets.id, id),
          eq(fundAssets.workspace_id, this.workspaceId),
          eq(fundAssets.ai_opinion_status, 'processing'),
        ),
      )
      .returning();
    return row;
  }
}
