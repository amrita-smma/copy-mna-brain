import { PAID_IN_WRITEOFF_SUBTYPE } from '@/lib/fundLedger/paidInAdjustment';
import {
  and,
  asc,
  eq,
  inArray,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  flAssets,
  flBusinessEvents,
  flLedgerEntries,
  flPositions,
} from '@/lib/db/schema';
import type {
  DbClient,
  FlLedgerEntryPagination,
  PositionDeltaSums,
  Tables,
  TablesInsert,
} from './types';
import { SUB_TYPE_DIVESTMENT_CASH_IN_FUND } from '@/lib/sellProceedsDestination';

export class FlLedgerEntryRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    entry: TablesInsert<'fl_ledger_entries'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flLedgerEntries)
      .values(entry)
      .returning();
    return row;
  }

  async createMany(
    entries: TablesInsert<'fl_ledger_entries'>[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    if (entries.length === 0) return [];
    return this.getExecutor(executor)
      .insert(flLedgerEntries)
      .values(entries)
      .returning();
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'> | undefined> {
    const rows = await this.getExecutor(executor)
      .select({ entry: flLedgerEntries })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flLedgerEntries.id, id),
        ),
      )
      .limit(1);
    return rows[0]?.entry;
  }

  async findByBusinessEventId(
    workspaceId: string,
    businessEventId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ entry: flLedgerEntries })
      .from(flLedgerEntries)
      .innerJoin(
        flBusinessEvents,
        eq(flLedgerEntries.business_event_id, flBusinessEvents.id),
      )
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          eq(flLedgerEntries.business_event_id, businessEventId),
        ),
      )
      .orderBy(
        asc(flLedgerEntries.entry_date),
        asc(flLedgerEntries.id),
      );
    return rows.map((r: { entry: Tables<'fl_ledger_entries'> }) => r.entry);
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ entry: flLedgerEntries })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(eq(flPositions.workspace_id, workspaceId))
      .orderBy(
        asc(flLedgerEntries.entry_date),
        asc(flLedgerEntries.id),
      );
    return rows.map((r: { entry: Tables<'fl_ledger_entries'> }) => r.entry);
  }

  async findByPositionIds(
    workspaceId: string,
    positionIds: string[],
    pagination?: FlLedgerEntryPagination,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    if (positionIds.length === 0) return [];

    const rawLimit = pagination?.limit ?? 50;
    const limit = Math.min(Math.max(1, rawLimit), 200);
    const offset =
      pagination?.offset !== undefined
        ? Math.max(0, pagination.offset)
        : undefined;

    let query = this.getExecutor(executor)
      .select({ entry: flLedgerEntries })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flLedgerEntries.position_id, positionIds),
        ),
      )
      .orderBy(
        asc(flLedgerEntries.position_id),
        asc(flLedgerEntries.entry_date),
        asc(flLedgerEntries.id),
      )
      .limit(limit);

    if (offset !== undefined) {
      query = (query as any).offset(offset);
    }

    const rows = await query;
    return rows.map((r: { entry: Tables<'fl_ledger_entries'> }) => r.entry);
  }

  async findAllByPositionIds(
    workspaceId: string,
    positionIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    if (positionIds.length === 0) return [];

    const rows = await this.getExecutor(executor)
      .select({ entry: flLedgerEntries })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flLedgerEntries.position_id, positionIds),
        ),
      )
      .orderBy(
        asc(flLedgerEntries.position_id),
        asc(flLedgerEntries.entry_date),
        asc(flLedgerEntries.id),
      );

    return rows.map((r: { entry: Tables<'fl_ledger_entries'> }) => r.entry);
  }

  async countByPositionIds(
    workspaceId: string,
    positionIds: string[],
    executor?: DbClient,
  ): Promise<number> {
    if (positionIds.length === 0) return 0;

    const rows = await this.getExecutor(executor)
      .select({ count: sql<number>`count(*)::int` })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flLedgerEntries.position_id, positionIds),
        ),
      );

    return Number(rows[0]?.count ?? 0);
  }

  async sumDeltasByPositionIds(
    workspaceId: string,
    positionIds: string[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<PositionDeltaSums[]> {
    if (positionIds.length === 0) return [];

    const conditions: SQL[] = [
      eq(flPositions.workspace_id, workspaceId),
      inArray(flLedgerEntries.position_id, positionIds),
    ];
    if (asOfDate) {
      conditions.push(lte(flLedgerEntries.entry_date, asOfDate));
    }

    const rows = await this.getExecutor(executor)
      .select({
        position_id: flLedgerEntries.position_id,
        asset_kind: flAssets.asset_kind,
        commitment_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.commitment_delta}), 0)::text`,
        quantity_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.quantity_delta}), 0)::text`,
        cash_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.cash_delta}), 0)::text`,
        contributed_sum: sql<string>`COALESCE(SUM(-${flLedgerEntries.cash_delta}) FILTER (WHERE ${flLedgerEntries.entry_type} IN ('paid_in', 'buy')), 0)::text`,
        paid_in_adjustment_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.valuation_delta}) FILTER (WHERE ${flLedgerEntries.entry_type} = 'adjustment' AND ${flLedgerEntries.sub_type} = ${PAID_IN_WRITEOFF_SUBTYPE}), 0)::text`,
        valuation_delta_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.valuation_delta}) FILTER (WHERE NOT (${flLedgerEntries.entry_type} = 'adjustment' AND ${flLedgerEntries.sub_type} IS NOT DISTINCT FROM ${PAID_IN_WRITEOFF_SUBTYPE})), 0)::text`,
        // `divestment` is a subtype, not an fl_entry_type enum value. Including
        // it here makes PostgreSQL reject the entire aggregate while coercing
        // the IN-list literals to fl_entry_type.
        // FoF divestments / distributions retained in the fund use entry_type 'distribution'
        // with sub_type 'divestment:cash_in_fund' or 'cash_in_fund'.
        retained_proceeds_sum: sql<string>`COALESCE(SUM(${flLedgerEntries.cash_delta}) FILTER (WHERE ${flLedgerEntries.entry_type} IN ('sell', 'redemption', 'distribution') AND (${flLedgerEntries.sub_type} = ${SUB_TYPE_DIVESTMENT_CASH_IN_FUND} OR ${flLedgerEntries.sub_type} = 'cash_in_fund')), 0)::text`,
      })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .leftJoin(
        flAssets,
        eq(flPositions.asset_id, flAssets.id),
      )
      .where(and(...conditions))
      .groupBy(flLedgerEntries.position_id, flAssets.asset_kind)
      .orderBy(asc(flLedgerEntries.position_id));

    return rows;
  }

  async deleteByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.getExecutor(executor)
      .select({ id: flLedgerEntries.id })
      .from(flLedgerEntries)
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flLedgerEntries.id, ids),
        ),
      );
    const scopedIds = rows.map((row) => row.id);
    if (scopedIds.length === 0) return;
    await this.getExecutor(executor)
      .delete(flLedgerEntries)
      .where(inArray(flLedgerEntries.id, scopedIds));
  }

  async deleteByBusinessEventId(
    workspaceId: string,
    businessEventId: string,
    executor?: DbClient,
  ): Promise<void> {
    const entries = await this.findByBusinessEventId(
      workspaceId,
      businessEventId,
      executor,
    );
    await this.deleteByIds(
      workspaceId,
      entries.map((entry) => entry.id),
      executor,
    );
  }
}
