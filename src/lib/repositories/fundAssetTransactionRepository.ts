import { and, eq, inArray } from 'drizzle-orm';
import { fundAssetTransactions, fundAssets, funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FundAssetTransactionRepository {
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

  /** The full ledger for an asset, oldest transaction first. */
  async findByFundAssetId(fundAssetId: string): Promise<Tables<'fund_asset_transactions'>[]> {
    return this.db
      .select()
      .from(fundAssetTransactions)
      .where(
        and(
          eq(fundAssetTransactions.fund_asset_id, fundAssetId),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .orderBy(fundAssetTransactions.txn_date);
  }

  /**
   * The full ledger for many assets at once — the batched counterpart to
   * findByFundAssetId, ordered by (fund_asset_id, txn_date) so callers can
   * group by asset in a single pass while each asset's transactions keep the
   * same oldest-first order the single-asset query returns.
   */
  async findByFundAssetIds(
    fundAssetIds: string[],
  ): Promise<Tables<'fund_asset_transactions'>[]> {
    if (fundAssetIds.length === 0) return [];
    return this.db
      .select()
      .from(fundAssetTransactions)
      .where(
        and(
          inArray(fundAssetTransactions.fund_asset_id, fundAssetIds),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .orderBy(fundAssetTransactions.fund_asset_id, fundAssetTransactions.txn_date);
  }

  async findById(id: string): Promise<Tables<'fund_asset_transactions'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundAssetTransactions)
      .where(
        and(
          eq(fundAssetTransactions.id, id),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .limit(1);
    return row;
  }

  async insert(
    data: TablesInsert<'fund_asset_transactions'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    // Trusts the caller-supplied fund_asset_id belongs to this workspace,
    // same trust boundary as TrackVariableRepository.insert.
    const [row] = await this.db.insert(fundAssetTransactions).values(data).returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'fund_asset_transactions'>,
  ): Promise<Tables<'fund_asset_transactions'> | undefined> {
    const [row] = await this.db
      .update(fundAssetTransactions)
      .set(updates)
      .where(
        and(
          eq(fundAssetTransactions.id, id),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(fundAssetTransactions)
      .where(
        and(
          eq(fundAssetTransactions.id, id),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      );
  }
}
