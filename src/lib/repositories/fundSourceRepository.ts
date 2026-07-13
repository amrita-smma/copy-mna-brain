import { and, eq } from 'drizzle-orm';
import { fundingSources } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

/** Source-of-fund capital pools (the shared `funding_sources` table). */
export class FundSourceRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findAll(): Promise<Tables<'funding_sources'>[]> {
    return this.db
      .select()
      .from(fundingSources)
      .where(eq(fundingSources.workspace_id, this.workspaceId))
      .orderBy(fundingSources.name, fundingSources.id);
  }

  async findById(id: string): Promise<Tables<'funding_sources'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundingSources)
      .where(and(eq(fundingSources.id, id), eq(fundingSources.workspace_id, this.workspaceId)))
      .limit(1);
    return row;
  }

  // workspace_id is always this.workspaceId, regardless of what's passed in.
  async insert(
    data: Omit<TablesInsert<'funding_sources'>, 'workspace_id'>,
  ): Promise<Tables<'funding_sources'>> {
    const [row] = await this.db
      .insert(fundingSources)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'funding_sources'>,
  ): Promise<Tables<'funding_sources'> | undefined> {
    const [row] = await this.db
      .update(fundingSources)
      .set(updates)
      .where(and(eq(fundingSources.id, id), eq(fundingSources.workspace_id, this.workspaceId)))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(fundingSources)
      .where(and(eq(fundingSources.id, id), eq(fundingSources.workspace_id, this.workspaceId)));
  }
}
