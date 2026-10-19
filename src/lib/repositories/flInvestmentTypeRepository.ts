import { and, asc, eq, sql } from 'drizzle-orm';
import { flInvestmentTypes } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlInvestmentTypeRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flInvestmentTypes)
      .where(eq(flInvestmentTypes.workspace_id, workspaceId))
      .orderBy(asc(flInvestmentTypes.sort_order), asc(flInvestmentTypes.name));
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flInvestmentTypes)
      .where(and(eq(flInvestmentTypes.workspace_id, workspaceId), eq(flInvestmentTypes.id, id)))
      .limit(1);
    return row;
  }

  async create(
    data: TablesInsert<'fl_investment_types'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flInvestmentTypes)
      .values(data)
      .returning();
    return row;
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_investment_types'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flInvestmentTypes)
      .set({ ...updates, updated_at: sql`now()` })
      .where(and(eq(flInvestmentTypes.workspace_id, workspaceId), eq(flInvestmentTypes.id, id)))
      .returning();
    return row;
  }

  /** Deletes the type; its assets are unassigned by the FK's ON DELETE SET NULL. */
  async delete(workspaceId: string, id: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
      .delete(flInvestmentTypes)
      .where(and(eq(flInvestmentTypes.workspace_id, workspaceId), eq(flInvestmentTypes.id, id)));
  }
}
