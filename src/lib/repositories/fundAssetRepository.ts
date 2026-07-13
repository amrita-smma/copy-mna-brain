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
}
