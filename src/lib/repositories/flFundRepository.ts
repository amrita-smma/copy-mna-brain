import { resolveFundVehiclesEnabled } from '@/lib/features/fundVehicles';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { flFunds } from '@/lib/db/schema';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlFundRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_funds'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>> {
    if (data.managed !== true && !(await resolveFundVehiclesEnabled(data.workspace_id))) {
      throw new Error('Fund Vehicle View is disabled. Create external fund investments as assets.');
    }
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flFunds)
      .values(payload)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_funds'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>> {
    return this.create(data, executor);
  }

  async insertOnConflictDoNothing(
    data: TablesInsert<'fl_funds'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'> | undefined> {
    if (data.managed !== true && !(await resolveFundVehiclesEnabled(data.workspace_id))) {
      throw new Error('Fund Vehicle View is disabled. Create external fund investments as assets.');
    }
    const payload = {
      ...data,
      canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
    };
    const [row] = await this.getExecutor(executor)
      .insert(flFunds)
      .values(payload)
      .onConflictDoNothing({
        target: [flFunds.workspace_id, flFunds.canonical_name],
      })
      .returning();
    return row;
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flFunds)
      .where(
        and(
          eq(flFunds.workspace_id, workspaceId),
          eq(flFunds.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByCanonicalName(
    workspaceId: string,
    canonicalName: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flFunds)
      .where(
        and(
          eq(flFunds.workspace_id, workspaceId),
          eq(flFunds.canonical_name, canonicalName),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flFunds)
      .where(
        and(
          eq(flFunds.workspace_id, workspaceId),
          inArray(flFunds.id, ids),
        ),
      )
      .orderBy(asc(flFunds.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flFunds)
      .where(eq(flFunds.workspace_id, workspaceId))
      .orderBy(asc(flFunds.name), asc(flFunds.id));
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_funds'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'> | undefined> {
    if (!(await resolveFundVehiclesEnabled(workspaceId))) {
      const existing = await this.findById(workspaceId, id, executor);
      if (!existing) return undefined;
      if (!existing.managed || updates.managed === false) {
        throw new Error('Fund Vehicle View is disabled. Unmanaged funds cannot be updated.');
      }
    }
    const payload = {
      ...updates,
      ...(updates.name !== undefined && updates.canonical_name === undefined
        ? { canonical_name: normalizeCanonicalName(updates.name) }
        : {}),
      updated_at: sql`now()`,
    };
    const [row] = await this.getExecutor(executor)
      .update(flFunds)
      .set(payload)
      .where(
        and(
          eq(flFunds.workspace_id, workspaceId),
          eq(flFunds.id, id),
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
      .delete(flFunds)
      .where(
        and(
          eq(flFunds.workspace_id, workspaceId),
          eq(flFunds.id, id),
        ),
      );
  }
}
