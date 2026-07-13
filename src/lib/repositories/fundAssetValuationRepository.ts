import { and, desc, eq, inArray } from 'drizzle-orm';
import { fundAssetValuations, fundAssets, funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FundAssetValuationRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceFundAssetIds() {
    return this.db
      .select({ id: fundAssets.id })
      .from(fundAssets)
      .where(eq(fundAssets.workspace_id, this.workspaceId));
  }

  /** All snapshots for an asset, most recent `as_of_date` first. */
  async findByFundAssetId(fundAssetId: string): Promise<Tables<'fund_asset_valuations'>[]> {
    return this.db
      .select()
      .from(fundAssetValuations)
      .where(
        and(
          eq(fundAssetValuations.fund_asset_id, fundAssetId),
          inArray(fundAssetValuations.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .orderBy(desc(fundAssetValuations.as_of_date));
  }

  async findLatestByFundAssetId(
    fundAssetId: string,
  ): Promise<Tables<'fund_asset_valuations'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundAssetValuations)
      .where(
        and(
          eq(fundAssetValuations.fund_asset_id, fundAssetId),
          inArray(fundAssetValuations.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .orderBy(desc(fundAssetValuations.as_of_date))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<Tables<'fund_asset_valuations'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundAssetValuations)
      .where(
        and(
          eq(fundAssetValuations.id, id),
          inArray(fundAssetValuations.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .limit(1);
    return row;
  }

  async insert(
    data: TablesInsert<'fund_asset_valuations'>,
  ): Promise<Tables<'fund_asset_valuations'>> {
    const [row] = await this.db.insert(fundAssetValuations).values(data).returning();
    return row;
  }

  /**
   * Insert a snapshot, or overwrite it in place if one already exists for
   * this `(fund_asset_id, as_of_date)` — reprocessing the same as_of_date
   * (e.g. a corrected capital account statement) updates atomically instead
   * of racing a separate find-then-insert-or-update against the unique
   * constraint.
   */
  async upsert(
    data: TablesInsert<'fund_asset_valuations'>,
  ): Promise<Tables<'fund_asset_valuations'>> {
    const [row] = await this.db
      .insert(fundAssetValuations)
      .values(data)
      .onConflictDoUpdate({
        target: [fundAssetValuations.fund_asset_id, fundAssetValuations.as_of_date],
        set: { ...data, updated_at: new Date().toISOString() },
      })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'fund_asset_valuations'>,
  ): Promise<Tables<'fund_asset_valuations'> | undefined> {
    const [row] = await this.db
      .update(fundAssetValuations)
      .set(updates)
      .where(
        and(
          eq(fundAssetValuations.id, id),
          inArray(fundAssetValuations.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(fundAssetValuations)
      .where(
        and(
          eq(fundAssetValuations.id, id),
          inArray(fundAssetValuations.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      );
  }
}
