import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { flAssets } from '@/lib/db/schema';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlAssetRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_assets'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flAssets)
      .values(payload)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_assets'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    return this.create(data, executor);
  }

  async insertOnConflictDoNothing(
    data: TablesInsert<'fl_assets'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flAssets)
      .values(payload)
      .onConflictDoNothing({
        target: [flAssets.workspace_id, flAssets.canonical_name],
      })
      .returning();
    return row;
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flAssets)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          eq(flAssets.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByCanonicalName(
    workspaceId: string,
    canonicalName: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flAssets)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          eq(flAssets.canonical_name, canonicalName),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flAssets)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          inArray(flAssets.id, ids),
        ),
      )
      .orderBy(asc(flAssets.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flAssets)
      .where(eq(flAssets.workspace_id, workspaceId))
      .orderBy(asc(flAssets.name), asc(flAssets.id));
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_assets'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    const payload = {
      ...updates,
      ...(updates.name !== undefined && updates.canonical_name === undefined
        ? { canonical_name: normalizeCanonicalName(updates.name) }
        : {}),
      updated_at: sql`now()`,
    };
    const [row] = await this.getExecutor(executor)
      .update(flAssets)
      .set(payload)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          eq(flAssets.id, id),
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
      .delete(flAssets)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          eq(flAssets.id, id),
        ),
      );
  }

  async findSystemCashAsset(
    workspaceId: string,
    currency: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    const normalizedCurrency = currency.trim().toUpperCase();
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flAssets)
      .where(
        and(
          eq(flAssets.workspace_id, workspaceId),
          eq(flAssets.asset_kind, 'cash'),
          sql`${flAssets.instrument_terms}->>'system_cash' = 'true'`,
          sql`${flAssets.instrument_terms}->>'currency' = ${normalizedCurrency}`,
        ),
      )
      .limit(1);
    return row;
  }
}
