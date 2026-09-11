import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { flInvestors } from '@/lib/db/schema';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlInvestorRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_investors'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flInvestors)
      .values(payload)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_investors'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>> {
    return this.create(data, executor);
  }

  async insertOnConflictDoNothing(
    data: TablesInsert<'fl_investors'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'> | undefined> {
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flInvestors)
      .values(payload)
      .onConflictDoNothing({
        target: [flInvestors.workspace_id, flInvestors.canonical_name],
      })
      .returning();
    return row;
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flInvestors)
      .where(
        and(
          eq(flInvestors.workspace_id, workspaceId),
          eq(flInvestors.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByCanonicalName(
    workspaceId: string,
    canonicalName: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flInvestors)
      .where(
        and(
          eq(flInvestors.workspace_id, workspaceId),
          eq(flInvestors.canonical_name, canonicalName),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flInvestors)
      .where(
        and(
          eq(flInvestors.workspace_id, workspaceId),
          inArray(flInvestors.id, ids),
        ),
      )
      .orderBy(asc(flInvestors.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flInvestors)
      .where(eq(flInvestors.workspace_id, workspaceId))
      .orderBy(asc(flInvestors.name), asc(flInvestors.id));
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_investors'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'> | undefined> {
    const payload = {
      ...updates,
      ...(updates.name !== undefined && updates.canonical_name === undefined
        ? { canonical_name: normalizeCanonicalName(updates.name) }
        : {}),
      updated_at: sql`now()`,
    };
    const [row] = await this.getExecutor(executor)
      .update(flInvestors)
      .set(payload)
      .where(
        and(
          eq(flInvestors.workspace_id, workspaceId),
          eq(flInvestors.id, id),
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
      .delete(flInvestors)
      .where(
        and(
          eq(flInvestors.workspace_id, workspaceId),
          eq(flInvestors.id, id),
        ),
      );
  }
}
