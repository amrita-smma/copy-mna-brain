import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  flAssets,
  flFunds,
  flPositions,
  flValuations,
} from '@/lib/db/schema';
import type {
  DbClient,
  FlValuationTarget,
  Tables,
  TablesInsert,
  TablesUpdate,
} from './types';

export class FlValuationRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_valuations'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flValuations)
      .values(data)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_valuations'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>> {
    return this.create(data, executor);
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    const rows = await this.getExecutor(executor)
      .select({ valuation: flValuations })
      .from(flValuations)
      .leftJoin(flAssets, eq(flValuations.asset_id, flAssets.id))
      .leftJoin(flFunds, eq(flValuations.fund_id, flFunds.id))
      .leftJoin(flPositions, eq(flValuations.position_id, flPositions.id))
      .where(
        and(
          eq(flValuations.id, id),
          or(
            eq(flAssets.workspace_id, workspaceId),
            eq(flFunds.workspace_id, workspaceId),
            eq(flPositions.workspace_id, workspaceId),
          ),
        ),
      )
      .limit(1);
    return rows[0]?.valuation;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (ids.length === 0) return [];
    const rows = await this.getExecutor(executor)
      .select({ valuation: flValuations })
      .from(flValuations)
      .leftJoin(flAssets, eq(flValuations.asset_id, flAssets.id))
      .leftJoin(flFunds, eq(flValuations.fund_id, flFunds.id))
      .leftJoin(flPositions, eq(flValuations.position_id, flPositions.id))
      .where(
        and(
          inArray(flValuations.id, ids),
          or(
            eq(flAssets.workspace_id, workspaceId),
            eq(flFunds.workspace_id, workspaceId),
            eq(flPositions.workspace_id, workspaceId),
          ),
        ),
      )
      .orderBy(asc(flValuations.id));
    return rows.map((r: { valuation: Tables<'fl_valuations'> }) => r.valuation);
  }

  async findLatestByAssetIds(
    workspaceId: string,
    assetIds: string[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (assetIds.length === 0) return [];

    const conditions: SQL[] = [
      eq(flAssets.workspace_id, workspaceId),
      inArray(flValuations.asset_id, assetIds),
    ];
    if (asOfDate) {
      conditions.push(lte(flValuations.as_of_date, asOfDate));
    }

    const rows = await (this.getExecutor(executor) as any)
      .selectDistinctOn([flValuations.asset_id], { valuation: flValuations })
      .from(flValuations)
      .innerJoin(flAssets, eq(flValuations.asset_id, flAssets.id))
      .where(and(...conditions))
      .orderBy(
        asc(flValuations.asset_id),
        desc(flValuations.as_of_date),
        desc(flValuations.id),
      );

    return rows.map((r: any) => r.valuation);
  }

  async findLatestByFundIds(
    workspaceId: string,
    fundIds: string[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (fundIds.length === 0) return [];

    const conditions: SQL[] = [
      eq(flFunds.workspace_id, workspaceId),
      inArray(flValuations.fund_id, fundIds),
    ];
    if (asOfDate) {
      conditions.push(lte(flValuations.as_of_date, asOfDate));
    }

    const rows = await (this.getExecutor(executor) as any)
      .selectDistinctOn([flValuations.fund_id], { valuation: flValuations })
      .from(flValuations)
      .innerJoin(flFunds, eq(flValuations.fund_id, flFunds.id))
      .where(and(...conditions))
      .orderBy(
        asc(flValuations.fund_id),
        desc(flValuations.as_of_date),
        desc(flValuations.id),
      );

    return rows.map((r: any) => r.valuation);
  }

  async findLatestByPositionIds(
    workspaceId: string,
    positionIds: string[],
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (positionIds.length === 0) return [];

    const conditions: SQL[] = [
      eq(flPositions.workspace_id, workspaceId),
      inArray(flValuations.position_id, positionIds),
      sql`(${flPositions.opened_at} IS NULL OR ${flValuations.as_of_date} >= ${flPositions.opened_at})`,
    ];
    if (asOfDate) {
      conditions.push(lte(flValuations.as_of_date, asOfDate));
    }

    const rows = await (this.getExecutor(executor) as any)
      .selectDistinctOn([flValuations.position_id], { valuation: flValuations })
      .from(flValuations)
      .innerJoin(flPositions, eq(flValuations.position_id, flPositions.id))
      .where(and(...conditions))
      .orderBy(
        asc(flValuations.position_id),
        desc(flValuations.as_of_date),
        desc(flValuations.id),
      );

    return rows.map((r: any) => r.valuation);
  }

  async findSeriesByTarget(
    workspaceId: string,
    target: FlValuationTarget,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (target.assetId) {
      const rows = await this.getExecutor(executor)
        .select({ valuation: flValuations })
        .from(flValuations)
        .innerJoin(flAssets, eq(flValuations.asset_id, flAssets.id))
        .where(
          and(
            eq(flAssets.workspace_id, workspaceId),
            eq(flValuations.asset_id, target.assetId),
          ),
        )
        .orderBy(asc(flValuations.as_of_date), asc(flValuations.id));
      return rows.map((r: any) => r.valuation);
    }

    if (target.fundId) {
      const rows = await this.getExecutor(executor)
        .select({ valuation: flValuations })
        .from(flValuations)
        .innerJoin(flFunds, eq(flValuations.fund_id, flFunds.id))
        .where(
          and(
            eq(flFunds.workspace_id, workspaceId),
            eq(flValuations.fund_id, target.fundId),
          ),
        )
        .orderBy(asc(flValuations.as_of_date), asc(flValuations.id));
      return rows.map((r: any) => r.valuation);
    }

    if (target.positionId) {
      const rows = await this.getExecutor(executor)
        .select({ valuation: flValuations })
        .from(flValuations)
        .innerJoin(flPositions, eq(flValuations.position_id, flPositions.id))
        .where(
          and(
            eq(flPositions.workspace_id, workspaceId),
            eq(flValuations.position_id, target.positionId),
            sql`(${flPositions.opened_at} IS NULL OR ${flValuations.as_of_date} >= ${flPositions.opened_at})`,
          ),
        )
        .orderBy(asc(flValuations.as_of_date), asc(flValuations.id));
      return rows.map((r: any) => r.valuation);
    }

    return [];
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ valuation: flValuations })
      .from(flValuations)
      .leftJoin(flAssets, eq(flValuations.asset_id, flAssets.id))
      .leftJoin(flFunds, eq(flValuations.fund_id, flFunds.id))
      .leftJoin(flPositions, eq(flValuations.position_id, flPositions.id))
      .where(
        or(
          eq(flAssets.workspace_id, workspaceId),
          eq(flFunds.workspace_id, workspaceId),
          eq(flPositions.workspace_id, workspaceId),
        ),
      )
      .orderBy(asc(flValuations.as_of_date), asc(flValuations.id));
    return rows.map((r: any) => r.valuation);
  }

  /**
   * Targeted lookup for import correction identity: position + as_of_date marks.
   * Guards the empty-array case; orders by position_id then date for single-pass grouping.
   */
  async findByPositionIdsAndAsOfDates(
    workspaceId: string,
    positionIds: string[],
    asOfDates: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    if (positionIds.length === 0 || asOfDates.length === 0) return [];

    const uniquePositionIds = Array.from(new Set(positionIds.filter(Boolean)));
    const uniqueDates = Array.from(new Set(asOfDates.filter(Boolean)));
    if (uniquePositionIds.length === 0 || uniqueDates.length === 0) return [];

    const rows = await this.getExecutor(executor)
      .select({ valuation: flValuations })
      .from(flValuations)
      .innerJoin(flPositions, eq(flValuations.position_id, flPositions.id))
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flValuations.position_id, uniquePositionIds),
          inArray(flValuations.as_of_date, uniqueDates),
        ),
      )
      .orderBy(asc(flValuations.position_id), asc(flValuations.as_of_date), asc(flValuations.id));
    return rows.map((r: any) => r.valuation);
  }

  async update(
    id: string,
    updates: TablesUpdate<'fl_valuations'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flValuations)
      .set({ ...updates, updated_at: sql`now()` })
      .where(eq(flValuations.id, id))
      .returning();
    return row;
  }

  async delete(id: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
      .delete(flValuations)
      .where(eq(flValuations.id, id));
  }
}
