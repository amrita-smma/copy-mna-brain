import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { flFundingSources } from '@/lib/db/schema';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlFundingSourceRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_funding_sources'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flFundingSources)
      .values(payload)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_funding_sources'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>> {
    return this.create(data, executor);
  }

  async insertOnConflictDoNothing(
    data: TablesInsert<'fl_funding_sources'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'> | undefined> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flFundingSources)
      .values(payload)
      .onConflictDoNothing({
        target: [flFundingSources.workspace_id, flFundingSources.canonical_name],
      })
      .returning();
    return row;
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flFundingSources)
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          eq(flFundingSources.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByCanonicalName(
    workspaceId: string,
    canonicalName: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flFundingSources)
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          eq(flFundingSources.canonical_name, canonicalName),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flFundingSources)
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          inArray(flFundingSources.id, ids),
        ),
      )
      .orderBy(asc(flFundingSources.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flFundingSources)
      .where(eq(flFundingSources.workspace_id, workspaceId))
      .orderBy(asc(flFundingSources.name), asc(flFundingSources.id));
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_funding_sources'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'> | undefined> {
    const payload = {
      ...updates,
      ...(updates.name !== undefined && updates.canonical_name === undefined
        ? { canonical_name: normalizeCanonicalName(updates.name) }
        : {}),
      updated_at: sql`now()`,
    };
    const [row] = await this.getExecutor(executor)
      .update(flFundingSources)
      .set(payload)
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          eq(flFundingSources.id, id),
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
      .delete(flFundingSources)
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          eq(flFundingSources.id, id),
        ),
      );
  }
}
