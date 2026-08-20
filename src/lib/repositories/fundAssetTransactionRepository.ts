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

  async findBySourceDivestmentTxnId(
    divestmentTxnId: string,
  ): Promise<Tables<'fund_asset_transactions'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundAssetTransactions)
      .where(
        and(
          eq(fundAssetTransactions.source_divestment_txn_id, divestmentTxnId),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      )
      .limit(1);
    return row;
  }

  async deleteBySourceDivestmentTxnId(divestmentTxnId: string): Promise<void> {
    await this.db
      .delete(fundAssetTransactions)
      .where(
        and(
          eq(fundAssetTransactions.source_divestment_txn_id, divestmentTxnId),
          inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
        ),
      );
  }

  async upsertLinkedCashMovement(
    data: TablesInsert<'fund_asset_transactions'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    if (!data.source_divestment_txn_id) {
      throw new Error('source_divestment_txn_id is required to upsert a linked cash movement');
    }
    const existing = await this.findBySourceDivestmentTxnId(data.source_divestment_txn_id);
    if (existing) {
      const [updated] = await this.db
        .update(fundAssetTransactions)
        .set({
          fund_asset_id: data.fund_asset_id,
          fund_id: data.fund_id,
          holding_entity_id: data.holding_entity_id,
          funding_source_id: data.funding_source_id,
          txn_date: data.txn_date,
          txn_type: data.txn_type ?? 'internal_transfer',
          sub_type_label: data.sub_type_label,
          value_amount: data.value_amount,
          price_per_share: data.price_per_share ?? null,
          share_count: data.share_count ?? null,
          txn_currency: data.txn_currency,
          fx_rate: data.fx_rate,
          sell_proceeds_destination: null,
          notes: data.notes,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(fundAssetTransactions.id, existing.id),
            inArray(fundAssetTransactions.fund_asset_id, this.workspaceFundAssetIds()),
          ),
        )
        .returning();
      return updated ?? existing;
    }
    const [row] = await this.db.insert(fundAssetTransactions).values(data).returning();
    return row;
  }
}
