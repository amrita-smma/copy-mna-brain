import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { flPositions } from '@/lib/db/schema';
import type {
  DbClient,
  FlPositionNaturalKey,
  Tables,
  TablesInsert,
  TablesUpdate,
} from './types';

export class FlPositionRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_positions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flPositions)
      .values(data)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_positions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    return this.create(data, executor);
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flPositions.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.id, ids),
        ),
      )
      .orderBy(asc(flPositions.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(eq(flPositions.workspace_id, workspaceId))
      .orderBy(asc(flPositions.id));
  }

  async findByFundIds(
    workspaceId: string,
    fundIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (fundIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.fund_id, fundIds),
        ),
      )
      .orderBy(asc(flPositions.fund_id), asc(flPositions.id));
  }

  async findByHolderInvestorIds(
    workspaceId: string,
    holderInvestorIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (holderInvestorIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.holder_investor_id, holderInvestorIds),
        ),
      )
      .orderBy(asc(flPositions.holder_investor_id), asc(flPositions.id));
  }

  async findByHolderFundIds(
    workspaceId: string,
    holderFundIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (holderFundIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.holder_fund_id, holderFundIds),
        ),
      )
      .orderBy(asc(flPositions.holder_fund_id), asc(flPositions.id));
  }

  async findByAssetIds(
    workspaceId: string,
    assetIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (assetIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.asset_id, assetIds),
        ),
      )
      .orderBy(asc(flPositions.asset_id), asc(flPositions.id));
  }

  async findByHolderSourceOfFundIds(
    workspaceId: string,
    holderSourceOfFundIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (holderSourceOfFundIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.holder_source_of_fund_id, holderSourceOfFundIds),
        ),
      )
      .orderBy(asc(flPositions.holder_source_of_fund_id), asc(flPositions.id));
  }

  async findWithFilters(
    workspaceId: string,
    filters?: import('./types').FlPositionFilters,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    const conditions: SQL[] = [eq(flPositions.workspace_id, workspaceId)];

    if (filters?.fundId !== undefined) {
      conditions.push(eq(flPositions.fund_id, filters.fundId));
    }
    if (filters?.holderInvestorId !== undefined) {
      conditions.push(eq(flPositions.holder_investor_id, filters.holderInvestorId));
    }
    if (filters?.holderFundId !== undefined) {
      conditions.push(eq(flPositions.holder_fund_id, filters.holderFundId));
    }
    if (filters?.assetId !== undefined) {
      conditions.push(eq(flPositions.asset_id, filters.assetId));
    }
    if (filters?.holderSourceOfFundId !== undefined) {
      conditions.push(
        filters.holderSourceOfFundId === null
          ? isNull(flPositions.holder_source_of_fund_id)
          : eq(flPositions.holder_source_of_fund_id, filters.holderSourceOfFundId),
      );
    }

    return this.getExecutor(executor)
      .select()
      .from(flPositions)
      .where(and(...conditions))
      .orderBy(asc(flPositions.id));
  }

  async findByNaturalKey(
    workspaceId: string,
    key: FlPositionNaturalKey,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined>;
  async findByNaturalKey(
    workspaceId: string,
    holderInvestorId?: string | null,
    holderFundId?: string | null,
    fundId?: string | null,
    assetId?: string | null,
    holderSourceOfFundId?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined>;
  async findByNaturalKey(
    workspaceId: string,
    keyOrHolderInvestorId?: FlPositionNaturalKey | string | null,
    holderFundIdOrExecutor?: string | null | DbClient,
    fundId?: string | null,
    assetId?: string | null,
    holderSourceOfFundIdOrExecutor?: string | null | DbClient,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    let key: FlPositionNaturalKey;
    let exec: DbClient | undefined;

    if (
      keyOrHolderInvestorId !== null &&
      keyOrHolderInvestorId !== undefined &&
      typeof keyOrHolderInvestorId === 'object'
    ) {
      key = keyOrHolderInvestorId as FlPositionNaturalKey;
      exec = holderFundIdOrExecutor as DbClient | undefined;
    } else {
      const holderInvestorId =
        typeof keyOrHolderInvestorId === 'string' || keyOrHolderInvestorId === null
          ? (keyOrHolderInvestorId as string | null)
          : undefined;
      const holderFundId =
        typeof holderFundIdOrExecutor === 'string' || holderFundIdOrExecutor === null
          ? (holderFundIdOrExecutor as string | null)
          : undefined;
      let holderSourceOfFundId: string | null | undefined;
      if (typeof holderSourceOfFundIdOrExecutor === 'string' || holderSourceOfFundIdOrExecutor === null) {
        holderSourceOfFundId = holderSourceOfFundIdOrExecutor as string | null;
        exec = executor;
      } else {
        exec = holderSourceOfFundIdOrExecutor as DbClient | undefined;
      }
      key = {
        holderInvestorId,
        holderFundId,
        fundId,
        assetId,
        holderSourceOfFundId,
      };
    }

    const conditions: SQL[] = [
      eq(flPositions.workspace_id, workspaceId),
      key.holderInvestorId
        ? eq(flPositions.holder_investor_id, key.holderInvestorId)
        : isNull(flPositions.holder_investor_id),
      key.holderFundId
        ? eq(flPositions.holder_fund_id, key.holderFundId)
        : isNull(flPositions.holder_fund_id),
      key.fundId
        ? eq(flPositions.fund_id, key.fundId)
        : isNull(flPositions.fund_id),
      key.assetId
        ? eq(flPositions.asset_id, key.assetId)
        : isNull(flPositions.asset_id),
      key.holderSourceOfFundId
        ? eq(flPositions.holder_source_of_fund_id, key.holderSourceOfFundId)
        : isNull(flPositions.holder_source_of_fund_id),
    ];

    const [row] = await this.getExecutor(exec)
      .select()
      .from(flPositions)
      .where(and(...conditions))
      .limit(1);
    return row;
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: 'open' | 'closed',
    closedAt?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flPositions)
      .set({
        status,
        closed_at: closedAt ?? null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flPositions.id, id),
        ),
      )
      .returning();
    return row;
  }

  async updateStatuses(
    workspaceId: string,
    ids: string[],
    status: 'open' | 'closed',
    closedAt?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (ids.length === 0) return [];
    const rows = await this.getExecutor(executor)
      .update(flPositions)
      .set({
        status,
        closed_at: closedAt ?? null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(flPositions.id, ids),
        ),
      )
      .returning();
    const map = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => map.get(id))
      .filter((r): r is Tables<'fl_positions'> => r !== undefined);
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_positions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flPositions)
      .set({ ...updates, updated_at: sql`now()` })
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flPositions.id, id),
        ),
      )
      .returning();
    return row;
  }

  async delete(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(flPositions)
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flPositions.id, id),
        ),
      );
  }

  async findCashPosition(
    workspaceId: string,
    fundIdOrHolder:
      | string
      | { kind: 'fund'; id: string }
      | { holder_kind: 'fund'; holder_id: string },
    cashAssetId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    if (typeof fundIdOrHolder !== 'string') {
      const id =
        'id' in fundIdOrHolder ? fundIdOrHolder.id : fundIdOrHolder.holder_id;
      return this.findCashPosition(workspaceId, id, cashAssetId, executor);
    }
    return this.findByNaturalKey(
      workspaceId,
      {
        holderInvestorId: null,
        holderFundId: fundIdOrHolder,
        fundId: null,
        assetId: cashAssetId,
        holderSourceOfFundId: null,
      },
      executor,
    );
  }
}
